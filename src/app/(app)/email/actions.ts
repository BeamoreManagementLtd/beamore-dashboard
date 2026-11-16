"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import type { Email } from "@/lib/project-setup";

/**
 * Emails written on the dashboard (Ronan, 16 Nov 2026): shown on screen to read and change, then, on a click, sent
 * from the person's own Gmail, saved in Gmail Drafts, or copied to paste somewhere else. Nothing is sent without
 * that click on Send.
 */
export type EmailKind = "info" | "followup" | "join";
export type Composed = Email & { kind: EmailKind; ref: string };
export type EmailResult = { ok: boolean; message: string };

export async function composeEmail(kind: EmailKind, ref: string): Promise<Composed | { error: string }> {
  await requireProfile();
  const admin = createServiceClient();
  try {
    if (kind === "info") { const { composeInfoRequest, matchChecklist } = await import("@/lib/project-setup"); await matchChecklist(admin, ref); return { ...(await composeInfoRequest(admin, ref)), kind, ref }; }
    if (kind === "followup") { const { composeProposalFollowUp } = await import("@/lib/project-setup"); return { ...(await composeProposalFollowUp(admin, ref)), kind, ref }; }
    const { composeJoinEmail } = await import("@/lib/clerk-join");
    return { ...(await composeJoinEmail(admin, ref)), kind, ref };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const clean = (e: Composed): Composed => ({ ...e, to: e.to.trim(), cc: e.cc?.trim() || undefined, subject: e.subject.trim() });
const valid = (list: string) => list.split(/[,;]/).map((x) => x.trim()).filter(Boolean).every((x) => /[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}>?$/i.test(x));

async function logIt(e: Composed, what: string, who: string) {
  const admin = createServiceClient();
  if (e.kind === "join") return;
  const kind = e.kind === "info" ? (what === "sent" ? "Info requested" : "Info request drafted") : what === "sent" ? "Follow-up sent" : "Follow-up drafted";
  await admin.from("project_events").insert({ project_id: e.ref, source: "team", kind, who, body: `${what === "sent" ? "Sent" : "Saved in Gmail Drafts"} to ${e.to}: "${e.subject}"` });
  if (e.kind === "info" && what === "sent") {
    // the items in the email count as asked for today
    const today = new Date().toISOString().slice(0, 10);
    await admin.from("project_info").update({ requested_on: today }).eq("project_id", e.ref).is("received_on", null).is("requested_on", null);
  }
  revalidatePath(`/projects/${e.ref}`);
  revalidatePath("/due");
}

export async function sendComposed(raw: Composed): Promise<EmailResult> {
  const me = await requireProfile();
  const e = clean(raw);
  if (!e.to || !valid(e.to) || (e.cc && !valid(e.cc))) return { ok: false, message: "Check the To and Cc addresses" };
  if (!e.subject || !e.body.trim()) return { ok: false, message: "The subject and the email can't be empty" };
  const admin = createServiceClient();
  try {
    const { sendEmail } = await import("@/lib/google-user");
    const r = await sendEmail(admin, me.id, e);
    await logIt(e, "sent", me.full_name?.split(" ")[0] ?? me.email);
    return { ok: true, message: `Sent from ${r.from} to ${e.to}` };
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, message: /Connect your email first/.test(m) ? "Connect your Gmail first (Reports → Settings), then press Send again" : `Not sent: ${m}` };
  }
}

export async function draftComposed(raw: Composed): Promise<EmailResult> {
  const me = await requireProfile();
  const e = clean(raw);
  try {
    const { saveDraft } = await import("@/lib/project-setup");
    await saveDraft(createServiceClient(), e);
    await logIt(e, "drafted", me.full_name?.split(" ")[0] ?? me.email);
    return { ok: true, message: "Saved in Ronan's Gmail Drafts (not sent)" };
  } catch (err) {
    return { ok: false, message: `Not saved: ${err instanceof Error ? err.message : String(err)}` };
  }
}
