"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { ONBOARDING } from "@/lib/onboarding";

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
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  await db.from("clerks").update({ email: s(form, "email"), phone: s(form, "phone") }).eq("id", clerkId);
  revalidatePath(`/personnel/${clerkId}`);
  revalidatePath("/personnel");
}

/** Adds the standard onboarding steps for a clerk (any already there are kept). */
export async function startOnboarding(clerkId: string) {
  const me = await requireProfile();
  const db = await createClient();
  const { data: have } = await db.from("onboarding_items").select("item").eq("clerk_id", clerkId);
  const missing = ONBOARDING.filter((i) => !(have ?? []).some((h) => h.item === i));
  if (missing.length) await db.from("onboarding_items").insert(missing.map((item) => ({ clerk_id: clerkId, item, owner_id: me.id })));
  revalidatePath(`/personnel/${clerkId}`);
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

export async function setActive(clerkId: string, active: boolean) {
  await requireProfile();
  const db = await createClient();
  await db.from("clerks").update({ active }).eq("id", clerkId);
  revalidatePath(`/personnel/${clerkId}`);
  revalidatePath("/personnel");
}
