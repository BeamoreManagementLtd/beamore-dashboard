"use server";
import { revalidatePath } from "next/cache";
import { requireProfile, requireDirector } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { onboardNewClerk, type Step } from "@/lib/clerk-onboard";

export type NewClerkResult = { ok: boolean; message?: string; clerkId?: string; name?: string; steps?: Step[]; password?: string; passwordSent?: boolean; email?: string };

const val = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** The "Add new clerk" form: adds them, then runs the whole onboarding (account, folders, portal, welcome draft, PPE). */
export async function addAndOnboardClerk(_prev: NewClerkResult | null, form: FormData): Promise<NewClerkResult> {
  const me = await requireProfile();
  const name = val(form, "name");
  const personal = val(form, "personal_email").toLowerCase() || null;
  const beamore = val(form, "beamore_email").toLowerCase() || null;
  const project = val(form, "project_id") || null;
  const role = val(form, "role") === "me" ? "me" : "building";
  const createAccount = form.get("create_account") === "on";
  const sendWelcome = form.get("send_welcome") === "on" && me.role === "director"; // only Ronan's adds send email
  if (!name) return { ok: false, message: "Add their name." };
  if (!val(form, "phone")) return { ok: false, message: "Add their mobile number (Google needs it for their account)." };
  if (beamore && !/^[a-z0-9._-]+@beamore\.co\.uk$/.test(beamore)) return { ok: false, message: "The Beamore address must end @beamore.co.uk, e.g. gareth.mayoh@beamore.co.uk" };
  if (createAccount && me.role !== "director") return { ok: false, message: "Only Ronan can create @beamore.co.uk accounts. Untick that box, or ask Ronan." };
  const db = await createClient();
  const { data: clash } = await db.from("clerks").select("id,name").or(`name.ilike.${name},email.ilike.${beamore ?? "-"}`).limit(1);
  if (clash?.length) return { ok: false, message: `${clash[0].name} is already in the dashboard. Open them under Personnel and use Start onboarding there.` };
  const { data: clerk, error } = await db.from("clerks").insert({ name, email: beamore ?? personal, personal_email: personal, phone: val(form, "phone") || null, active: true }).select("id").single();
  if (error || !clerk) return { ok: false, message: error?.message ?? "Couldn't add them" };
  await db.from("clerk_compliance").upsert({ clerk_id: clerk.id, onboarding_started: new Date().toISOString().slice(0, 10), onboarding_project_id: project, updated_at: new Date().toISOString() });
  if (project) {
    await db.from("projects").update(role === "me" ? { clerk_me_id: clerk.id, clerk_me_status: "have", clerk_me_source: "manual" } : { clerk_id: clerk.id, clerk_status: "have", clerk_source: "manual" }).eq("id", project);
    await db.from("project_events").insert({ project_id: project, source: "team", kind: role === "me" ? "M&E clerk of works" : "Clerk of works", who: (me.full_name ?? me.email).split(" ")[0], body: `${name} appointed (new to Beamore, onboarding started)` });
  }
  try {
    const { steps, password, passwordSent } = await onboardNewClerk(createServiceClient(), { clerkId: clerk.id, name, personalEmail: personal, beamoreEmail: beamore, phone: val(form, "phone"), projectId: project, createAccount, sendWelcome, addedBy: me.email });
    revalidatePath("/personnel");
    return { ok: true, clerkId: clerk.id, name, steps, password, passwordSent, email: beamore ?? undefined };
  } catch (e) {
    return { ok: false, clerkId: clerk.id, name, message: `Added ${name}, but the set-up stopped: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` };
  }
}

/** Where the Beamore manual lives (a Drive link): every new clerk is given access to it. */
export async function setManual(form: FormData) {
  const me = await requireDirector();
  const link = val(form, "manual");
  const id = /\/d\/([\w-]{20,})/.exec(link)?.[1] ?? /id=([\w-]{20,})/.exec(link)?.[1] ?? (/^[\w-]{20,}$/.test(link) ? link : null);
  const db = await createClient();
  await db.from("onboarding_settings").update({ manual_file_id: id, updated_at: new Date().toISOString(), updated_by: me.email }).eq("id", 1);
  revalidatePath("/personnel");
}
