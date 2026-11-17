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

/** Days a week a clerk works for us (5 = full time). */
export async function setDaysPerWeek(clerkId: string, days: number) {
  await requireProfile();
  if (!(days > 0 && days <= 7)) return { ok: false, message: "Days a week must be between 0.5 and 7" };
  const { error } = await createServiceClient().from("clerks").update({ days_per_week: days }).eq("id", clerkId);
  revalidatePath("/workload");
  revalidatePath(`/personnel/${clerkId}`);
  return error ? { ok: false, message: error.message } : { ok: true, message: "Saved" };
}
