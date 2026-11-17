"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

/** A month changed by hand (a job slipped): kept over the cost schedule until cleared. days null = back to the cost schedule. */
export async function setMonthDays(projectId: string, month: string, kind: "building" | "me", days: number | null) {
  const me = await requireProfile();
  const db = createServiceClient();
  const { error } = days == null
    ? await db.from("workload_overrides").delete().eq("project_id", projectId).eq("month", month).eq("kind", kind)
    : await db.from("workload_overrides").upsert({ project_id: projectId, month, kind, days, updated_by: me.id, updated_at: new Date().toISOString() });
  revalidatePath("/workload");
  return error ? { ok: false, message: error.message } : { ok: true, message: "Saved" };
}

/** Read the cost schedules again now, rather than waiting for the nightly read. */
export async function rereadCostSchedules() {
  await requireProfile();
  const { syncProposalPlans } = await import("@/lib/sync/proposal-sync");
  const r = await syncProposalPlans(createServiceClient());
  revalidatePath("/workload");
  return r;
}

/**
 * Work agreed verbally (Ronan, 17 Nov 2026), e.g. "Andy Collier does Airbus once a week". If the job has nobody
 * allocated for that side (building / M&E) yet, the clerk is allocated to it too, so everything else agrees.
 */
export async function addAgreed(input: {
  clerkId: string; projectId: string | null; label: string; kind: "building" | "me";
  days: number; per: "week" | "month"; from: string; to: string | null; note: string;
}) {
  const me = await requireProfile();
  const db = createServiceClient();
  if (!input.clerkId) return { ok: false, message: "Choose the clerk" };
  if (!input.projectId && !input.label.trim()) return { ok: false, message: "Choose the job, or say what the work is" };
  if (!(input.days > 0 && input.days <= 31)) return { ok: false, message: "Enter how many days" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from)) return { ok: false, message: "Enter the date it starts" };
  if (input.to && input.to < input.from) return { ok: false, message: "The end date is before the start" };
  const { error } = await db.from("workload_agreed").insert({
    clerk_id: input.clerkId, project_id: input.projectId || null, label: input.projectId ? null : input.label.trim(), kind: input.kind,
    days: input.days, per: input.per, date_from: input.from, date_to: input.to || null, note: input.note.trim() || null, created_by: me.id,
  });
  if (error) return { ok: false, message: error.message };
  let also = "";
  if (input.projectId) {
    const col = input.kind === "me" ? "clerk_me_id" : "clerk_id";
    const { data: p } = await db.from("projects").select(`id,${col}`).eq("id", input.projectId).single();
    const cur = (p as Record<string, string | null> | null)?.[col];
    if (p && !cur) {
      await db.from("projects").update({ [col]: input.clerkId, updated_at: new Date().toISOString() }).eq("id", input.projectId);
      also = " and allocated them to the job";
    }
    const per = input.per === "week" ? "a week" : "a month";
    await db.from("project_events").insert({ project_id: input.projectId, source: "team", kind: "Agreed work", who: me.full_name ?? me.email,
      body: `${input.days} day${input.days === 1 ? "" : "s"} ${per} (${input.kind === "me" ? "M&E" : "building"}) from ${input.from}${input.to ? ` to ${input.to}` : " until further notice"}${input.note.trim() ? `: ${input.note.trim()}` : ""}` });
    revalidatePath(`/projects/${input.projectId}`);
  }
  revalidatePath("/workload");
  return { ok: true, message: `Added${also}` };
}

export async function removeAgreed(id: string) {
  await requireProfile();
  const { error } = await createServiceClient().from("workload_agreed").delete().eq("id", id);
  revalidatePath("/workload");
  return error ? { ok: false, message: error.message } : { ok: true, message: "Removed" };
}

/** Days a week a clerk works for us (5 = full time). */
export async function setDaysPerWeek(clerkId: string, days: number) {
  await requireProfile();
  if (!(days > 0 && days <= 7)) return { ok: false, message: "Days a week must be between 0.5 and 7" };
  const { error } = await createServiceClient().from("clerks").update({ days_per_week: days }).eq("id", clerkId);
  revalidatePath("/workload");
  revalidatePath(`/personnel/${clerkId}`);
  return error ? { ok: false, message: error.message } : { ok: true, message: "Saved" };
}
