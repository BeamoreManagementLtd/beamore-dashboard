"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { buildOnboarding } from "@/lib/onboarding";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim() || null;
const DBS = ["verified", "in_progress", "action_needed", "none"];

/** Saves a clerk's DBS, chartership and PPE details (decision 17: these live in the dashboard). */
export async function saveCompliance(clerkId: string, form: FormData) {
  await requireProfile();
  const db = await createClient();
  const status = s(form, "dbs_status");
  const { error } = await db.from("clerk_compliance").upsert({
    clerk_id: clerkId,
    dbs_level: s(form, "dbs_level"),
    dbs_status: status && DBS.includes(status) ? status : null,
    dbs_checked: s(form, "dbs_checked"),
    dbs_recheck: s(form, "dbs_recheck"),
    dbs_update_service: form.get("dbs_update_service") === "on",
    chartership_body: s(form, "chartership_body"),
    chartership_grade: s(form, "chartership_grade"),
    chartership_number: s(form, "chartership_number"),
    chartership_renewal: s(form, "chartership_renewal"),
    ppe_notes: s(form, "ppe_notes"),
    address: s(form, "address"),
    emergency_contact: s(form, "emergency_contact"),
    business_type: ["limited", "sole_trader", "umbrella"].includes(s(form, "business_type") ?? "") ? s(form, "business_type") : null,
    company_name: s(form, "company_name"),
    bank_details_received: s(form, "bank_details_received"),
    pi_insurance_expiry: s(form, "pi_insurance_expiry"),
    pl_insurance_expiry: s(form, "pl_insurance_expiry"),
    cscs_number: s(form, "cscs_number"),
    cscs_expiry: s(form, "cscs_expiry"),
    right_to_work_checked: s(form, "right_to_work_checked"),
    terms_signed: s(form, "terms_signed"),
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  await db.from("clerks").update({ email: s(form, "email"), phone: s(form, "phone") }).eq("id", clerkId);
  await refreshOnboarded(clerkId);
  revalidatePath(`/personnel/${clerkId}`);
  revalidatePath("/personnel");
}

/** Recomputes whether a clerk's onboarding is complete (every step green) and stores it. */
async function refreshOnboarded(clerkId: string) {
  const db = await createClient();
  const [{ data: c }, { data: clerk }, { data: items }, { count }] = await Promise.all([
    db.from("clerk_compliance").select("*").eq("clerk_id", clerkId).maybeSingle(),
    db.from("clerks").select("email,phone").eq("id", clerkId).maybeSingle(),
    db.from("onboarding_items").select("item,done_on").eq("clerk_id", clerkId),
    db.from("diary_visits").select("id", { count: "exact", head: true }).eq("clerk_id", clerkId),
  ]);
  if (!c?.onboarding_started) return;
  const ticked = new Map((items ?? []).filter((i) => i.done_on).map((i) => [i.item as string, i.done_on as string]));
  const o = buildOnboarding({ ...c, ...clerk }, ticked, (count ?? 0) > 0, new Date().toISOString().slice(0, 10));
  if (o.complete !== c.onboarding_complete) await db.from("clerk_compliance").update({ onboarding_complete: o.complete }).eq("clerk_id", clerkId);
}

/** A new person joining: creates them (named as they'll appear in the diary) and starts their onboarding. */
export async function addNewClerk(form: FormData) {
  await requireProfile();
  const db = await createClient();
  const name = s(form, "name");
  if (!name) return;
  const project = s(form, "project_id");
  const { data: clerk, error } = await db.from("clerks").insert({ name, email: s(form, "email"), phone: s(form, "phone"), active: true }).select("id").single();
  if (error) throw new Error(error.message.includes("duplicate") ? `There's already a clerk called ${name}` : error.message);
  await db.from("clerk_compliance").upsert({ clerk_id: clerk.id, onboarding_started: new Date().toISOString().slice(0, 10), onboarding_project_id: project, updated_at: new Date().toISOString() });
  const { createServiceClient } = await import("@/lib/supabase/server");
  const { ensureJoinToken } = await import("@/lib/clerk-join");
  await ensureJoinToken(createServiceClient(), clerk.id);
  if (project) {
    await db.from("projects").update({ clerk_id: clerk.id, clerk_status: "have" }).eq("id", project);
    await db.from("project_events").insert({ project_id: project, source: "team", kind: "Clerk of works", body: `${name} appointed (new to Beamore, onboarding started)` });
    revalidatePath(`/projects/${project}`);
  }
  revalidatePath("/personnel");
  redirect(`/personnel/${clerk.id}`);
}

/** Starts the onboarding workflow for a clerk already in the dashboard. */
export async function startOnboarding(clerkId: string) {
  await requireProfile();
  const db = await createClient();
  await db.from("clerk_compliance").upsert({ clerk_id: clerkId, onboarding_started: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() });
  await refreshOnboarded(clerkId);
  revalidatePath(`/personnel/${clerkId}`);
  revalidatePath("/personnel");
}

/** Ticks (or unticks) a hand-ticked onboarding step such as a piece of PPE. */
export async function tickOnboarding(clerkId: string, item: string, done: boolean) {
  const me = await requireProfile();
  const db = await createClient();
  await db.from("onboarding_items").delete().eq("clerk_id", clerkId).eq("item", item);
  if (done) await db.from("onboarding_items").insert({ clerk_id: clerkId, item, done_on: new Date().toISOString().slice(0, 10), owner_id: me.id });
  await refreshOnboarded(clerkId);
  revalidatePath(`/personnel/${clerkId}`);
  revalidatePath("/personnel");
  revalidatePath("/due");
}

export async function toggleOnboardingItem(clerkId: string, itemId: string, done: boolean) {
  await requireProfile();
  const db = await createClient();
  await db.from("onboarding_items").update({ done_on: done ? new Date().toISOString().slice(0, 10) : null }).eq("id", itemId);
  // all steps done → mark the clerk onboarded
  const { data: items } = await db.from("onboarding_items").select("done_on").eq("clerk_id", clerkId);
  const complete = !!items?.length && items.every((i) => i.done_on);
  await db.from("clerk_compliance").upsert({ clerk_id: clerkId, onboarding_complete: complete, updated_at: new Date().toISOString() });
  revalidatePath(`/personnel/${clerkId}`);
  revalidatePath("/personnel");
}

/** A holiday entered in the dashboard; it goes on the due list until the same days show as Holiday in the diary. */
export async function addAbsence(form: FormData) {
  await requireProfile();
  const db = await createClient();
  const clerk = s(form, "clerk_id"), from = s(form, "date_from"), to = s(form, "date_to") ?? from;
  if (!clerk || !from || !to || to < from) return;
  const part = s(form, "part_day");
  await db.from("absences").insert({
    clerk_id: clerk, date_from: from, date_to: to, part_day: part === "am" || part === "pm" ? part : null,
    kind: s(form, "kind") ?? "Holiday", status: form.get("provisional") === "on" ? "provisional" : "confirmed", source: "dashboard",
  });
  revalidatePath("/personnel");
  revalidatePath(`/personnel/${clerk}`);
  revalidatePath("/due");
}

export async function cancelAbsence(id: string) {
  await requireProfile();
  const db = await createClient();
  await db.from("absences").update({ status: "cancelled" }).eq("id", id).eq("source", "dashboard");
  revalidatePath("/personnel");
  revalidatePath("/due");
}

export async function setActive(clerkId: string, active: boolean) {
  await requireProfile();
  const db = await createClient();
  await db.from("clerks").update({ active }).eq("id", clerkId);
  revalidatePath(`/personnel/${clerkId}`);
  revalidatePath("/personnel");
}

/** The clerk's private questionnaire link (made on first use). */
export async function makeJoinLink(clerkId: string) {
  await requireProfile();
  const { createServiceClient } = await import("@/lib/supabase/server");
  const { ensureJoinToken } = await import("@/lib/clerk-join");
  await ensureJoinToken(createServiceClient(), clerkId);
  revalidatePath(`/personnel/${clerkId}`);
}

/** A Gmail draft to the clerk with their questionnaire link. Only ever a draft; Ronan presses Send. */
export async function draftJoin(clerkId: string) {
  await requireProfile();
  const { createServiceClient } = await import("@/lib/supabase/server");
  const { draftJoinEmail } = await import("@/lib/clerk-join");
  const admin = createServiceClient();
  let msg: string;
  try { msg = await draftJoinEmail(admin, clerkId); } catch (e) { msg = `Draft not saved: ${e instanceof Error ? e.message : String(e)}`; }
  redirect(`/personnel/${clerkId}?draft=${encodeURIComponent(msg)}`);
}
