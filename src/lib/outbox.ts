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
