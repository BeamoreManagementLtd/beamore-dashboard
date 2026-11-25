import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Emails the dashboard writes by itself wait on the "Emails to send" page instead of going into Gmail Drafts (Ronan,
 * 16 Nov 2026). Someone reads each one there and presses Send (from their own Gmail), Save to Gmail Drafts, Copy, or
 * Not needed. The same email (kind + ref) is only queued once while it's still waiting.
 */
export type Queued = {
  kind: string; to: string; cc?: string | null; subject: string; body: string; threadId?: string | null; inReplyTo?: string | null;
  projectId?: string | null; clerkId?: string | null; ref?: string | null; status?: "waiting" | "sent"; note?: string | null;
};

export async function queueEmail(admin: SupabaseClient, e: Queued) {
  if (e.ref && (e.status ?? "waiting") === "waiting") {
    const { data: same } = await admin.from("email_outbox").select("id").eq("kind", e.kind).eq("ref", e.ref).eq("status", "waiting").limit(1);
    if (same?.length) {
      // already waiting: bring it up to date rather than adding a second one
      await admin.from("email_outbox").update({ to_email: e.to, cc: e.cc ?? null, subject: e.subject, body: e.body, thread_id: e.threadId ?? null, in_reply_to: e.inReplyTo ?? null }).eq("id", same[0].id);
      return same[0].id as string;
    }
  }
  const { data, error } = await admin.from("email_outbox").insert({
    kind: e.kind, to_email: e.to ?? "", cc: e.cc ?? null, subject: e.subject, body: e.body, thread_id: e.threadId ?? null, in_reply_to: e.inReplyTo ?? null,
    project_id: e.projectId ?? null, clerk_id: e.clerkId ?? null, ref: e.ref ?? null, status: e.status ?? "waiting", note: e.note ?? null,
    ...(e.status === "sent" ? { done_at: new Date().toISOString() } : {}),
  }).select("id").single();
  if (error) throw new Error(`email list: ${error.message}`);
  return data.id as string;
}

/** "Hi Jonny" when the address has a name on it ("Jonny Rezai <jonny@...>"), otherwise just "Hi". */
export function greeting(to: string) {
  const name = /^\s*"?([A-Z][a-z'-]+)\b[^<,]*</.exec(to)?.[1];
  return name ? `Hi ${name}` : "Hi";
}

/**
 * Emails the dashboard sends by itself (report visit dates, monthly trackers, insurance renewals, portal corrections,
 * project details, missing reports) go from ai@beamore.co.uk, never from Ronan's address (Ronan, 25 Nov 2026). If that
 * mailbox can't send, the email waits on "Emails to send" instead. Signed "Beamore AI Assistant", not Ronan. `also`
 * records the same email against other refs (one email covering several reports).
 */
export async function sendFromAi(admin: SupabaseClient, e: Queued, also: Queued[] = []) {
  const body = e.body.replace(/\n+Ronan O'Boyle\n+Beamore Management Ltd\s*$/, "\n\nBeamore AI Assistant");
  const { sendFromMailbox, AI_MAILBOX } = await import("@/lib/google-user");
  const { driveClient } = await import("@/lib/google");
  let res: unknown = null;
  try {
    res = (await sendFromMailbox(admin, AI_MAILBOX, "Beamore AI Assistant", { to: e.to, subject: e.subject, body }))
      ?? (await (await driveClient(admin)).sendAutomaticAs({ email: AI_MAILBOX, name: "Beamore AI Assistant" }, { to: e.to, subject: e.subject, body }));
  } catch { res = null; }
  const status = res ? "sent" as const : "waiting" as const;
  const note = res ? "Sent automatically from ai@beamore.co.uk" : "ai@beamore.co.uk couldn't send it: check and send";
  for (const q of [e, ...also]) await queueEmail(admin, { ...q, body, status, note });
  return !!res;
}
