"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireProfile, requireDirector } from "@/lib/auth";
import { processUpload } from "@/lib/portal/process";

const audit = (actor: string, action: string, detail: object) => createServiceClient().from("portal_audit").insert({ actor, action, detail });
const done = () => revalidatePath("/clerk-portal");

/** Clears an issue once Beamore has dealt with it (the upload stays, as does its file in Drive). */
export async function resolveUpload(fd: FormData) {
  const me = await requireProfile();
  const id = String(fd.get("id"));
  const db = await createClient();
  await db.from("portal_uploads").update({ status: "accepted", resolved_at: new Date().toISOString(), resolved_by: me.email }).eq("id", id);
  await audit(me.email, "resolve", { id });
  done();
}

/** Runs the filing and AI reading again (e.g. after fixing a folder, or to re-read a certificate). */
export async function rereadUpload(fd: FormData) {
  const me = await requireProfile();
  const id = String(fd.get("id"));
  const admin = createServiceClient();
  await admin.from("portal_uploads").update({ ai_state: null, status: "filed", issues: [] }).eq("id", id).not("drive_file_id", "is", null);
  await audit(me.email, "reread", { id });
  after(() => processUpload(admin, id).catch(() => undefined));
  done();
}

/** Removes an upload from the portal lists. The file itself stays in Drive (the dashboard never deletes in Drive). */
export async function removeUpload(fd: FormData) {
  const me = await requireDirector();
  const id = String(fd.get("id")), reason = String(fd.get("reason") ?? "Removed");
  const db = await createClient();
  await db.from("portal_uploads").update({ status: "deleted", deleted_at: new Date().toISOString(), deleted_by: me.email, deleted_reason: reason }).eq("id", id);
  await db.from("insurance_policies").delete().eq("upload_id", id);
  await audit(me.email, "remove", { id, reason });
  done();
}

/** Monthly invoices: "not working this month" / expected again. */
export async function setExpected(fd: FormData) {
  const me = await requireProfile();
  const db = await createClient();
  await db.from("portal_expectations").upsert({ period: String(fd.get("period")), clerk_id: String(fd.get("clerk")), expected: fd.get("expected") === "1", updated_at: new Date().toISOString(), updated_by: me.email });
  done();
}

/** People & access (director only). */
export async function setAccess(fd: FormData) {
  const me = await requireDirector();
  const db = await createClient();
  const field = String(fd.get("field"));
  if (!["portal_access", "invoice_upload", "invoices_paused"].includes(field)) return;
  const value = fd.get("value") === "1";
  await db.from("clerks").update({ [field]: value }).eq("id", String(fd.get("clerk")));
  await audit(me.email, "access", { clerk: fd.get("clerk"), field, value });
  done();
}
