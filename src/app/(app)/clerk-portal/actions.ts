"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireProfile, requireDirector } from "@/lib/auth";
import { processUpload } from "@/lib/portal/process";
import { xeroClient } from "@/lib/xero";

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
  if (!["portal_access", "invoice_upload", "invoices_paused", "finance_visible"].includes(field)) return;
  const value = fd.get("value") === "1";
  await db.from("clerks").update({ [field]: value }).eq("id", String(fd.get("clerk")));
  await audit(me.email, "access", { clerk: fd.get("clerk"), field, value });
  done();
}

/** Ties a company to a person. "own" = their own business (they may see its invoices and payments in the portal);
 * "works_through" = an agency or contractor they work for (never shows its finances). Looks the company up in Xero. */
export async function addCompany(fd: FormData) {
  const me = await requireDirector();
  const clerk = String(fd.get("clerk") ?? ""), name = String(fd.get("company") ?? "").trim(), kind = fd.get("kind") === "works_through" ? "works_through" : "own";
  if (!clerk || !name) return;
  const db = await createClient();
  let contactId: string | null = null;
  try {
    const get = await xeroClient(createServiceClient());
    const r = await get<{ Contacts: { ContactID: string; Name: string }[] }>("Contacts", { searchTerm: name.replace(/\b(ltd|limited)\b.?/gi, "").trim(), page: 1 });
    const norm = (s: string) => s.toLowerCase().replace(/\b(ltd|limited)\b/g, "").replace(/[^a-z0-9]/g, "");
    contactId = r.Contacts.find((c) => norm(c.Name) === norm(name))?.ContactID ?? null;
  } catch { /* Xero unavailable: linked without payment history for now */ }
  const { data: c } = await db.from("clerks").select("email").eq("id", clerk).single();
  await db.from("clerk_companies").insert({ clerk_id: clerk, email: c?.email ?? null, company_name: name, kind, relationship: kind === "own" ? "Direct company" : "Works through", status: "Enabled", xero_contact_id: contactId, created_at: new Date().toISOString(), created_by: me.email });
  if (kind === "own") await db.from("clerks").update({ finance_visible: true }).eq("id", clerk).eq("finance_visible", false).not("id", "is", null).then(() => undefined);
  await audit(me.email, "company-link", { clerk, name, kind, contactId });
  const upload = fd.get("upload");
  if (upload) {
    await db.from("portal_uploads").update({ issues: [], status: "filed", ai_state: null }).eq("id", String(upload));
    after(() => processUpload(createServiceClient(), String(upload)).catch(() => undefined));
  }
  done();
}

export async function setCompanyKind(fd: FormData) {
  const me = await requireDirector();
  const db = await createClient();
  const id = String(fd.get("id")), kind = fd.get("kind") === "works_through" ? "works_through" : "own";
  await db.from("clerk_companies").update({ kind, updated_at: new Date().toISOString(), updated_by: me.email }).eq("id", id);
  done();
}

export async function revokeCompany(fd: FormData) {
  const me = await requireDirector();
  const db = await createClient();
  await db.from("clerk_companies").update({ status: "Revoked", updated_at: new Date().toISOString(), updated_by: me.email }).eq("id", String(fd.get("id")));
  done();
}

/** "This wording means this diary site" for one clerk; then the invoice is tried again. */
export async function setSiteAlias(fd: FormData) {
  const me = await requireProfile();
  const db = await createClient();
  const clerk = String(fd.get("clerk")), wording = String(fd.get("wording") ?? "").trim(), site = String(fd.get("site") ?? "").trim();
  if (!clerk || !wording || !site) return;
  const { data: ok } = await db.from("rates").select("site_as_typed").eq("site_as_typed", site).maybeSingle();
  if (!ok) return; // must be an exact diary / Rates name
  await db.from("site_aliases").upsert({ clerk_id: clerk, wording, site_as_typed: site, created_by: me.email }, { onConflict: "clerk_id,wording" });
  if (fd.get("upload")) await db.from("portal_uploads").update({ diary_state: "waiting", diary_note: "Waiting to go into the diary" }).eq("id", String(fd.get("upload")));
  done();
}

export async function retryDiary(fd: FormData) {
  await requireProfile();
  const db = await createClient();
  await db.from("portal_uploads").update({ diary_state: "waiting", diary_note: "Waiting to go into the diary" }).eq("id", String(fd.get("id")));
  done();
}
