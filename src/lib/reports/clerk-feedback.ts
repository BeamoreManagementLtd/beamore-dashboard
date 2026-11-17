import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { feedbackEmail, type FeedbackReport } from "./feedback-email";

/**
 * AI feedback ready (Ronan, 17 Nov 2026): a clerk who has switched on AI feedback in the portal gets an email from
 * ai@beamore.co.uk when one of their reports has been sent, with the feedback laid out like the portal page (score,
 * each part with a bar, what was fixed, suggestions). Once per report. Nothing is sent while ai@ isn't connected
 * (it never goes from Ronan's own address instead).
 */
export async function notifyAiFeedback(admin: SupabaseClient) {
  // only clerks who chose the emails as well as the feedback (Ronan, 17 Nov 2026: the emails are their own option)
  const { data: clerks } = await admin.from("clerks").select("id,name,email,active").eq("ai_feedback", true).eq("ai_feedback_email", true);
  const on = (clerks ?? []).filter((c) => c.email && c.active);
  if (!on.length) return { sent: 0, waiting: false };
  const { data: reps } = await admin.from("reports").select("id,clerk_id,file_name,score,clerk_points,fixes,projects(name,display_name)")
    .in("clerk_id", on.map((c) => c.id)).eq("status", "sent").gte("sent_at", new Date(Date.now() - 3 * 864e5).toISOString());
  if (!reps?.length) return { sent: 0, waiting: false };
  const { data: done } = await admin.from("email_outbox").select("ref").eq("kind", "ai-feedback").in("ref", reps.map((r) => r.id));
  const told = new Set((done ?? []).map((d) => d.ref));
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://dashboard.beamore.co.uk";
  const { driveClient } = await import("@/lib/google");
  const { queueEmail } = await import("@/lib/outbox");
  const { sendFromMailbox, AI_MAILBOX } = await import("@/lib/google-user");
  const g = await driveClient(admin);
  let sent = 0;
  for (const r of reps) {
    if (told.has(r.id)) continue;
    const c = on.find((x) => x.id === r.clerk_id)!;
    const p = r.projects as unknown as { name?: string; display_name?: string } | null;
    const job = p?.name ?? p?.display_name ?? "your job"; // the plain job name, without Beamore's job number
    const e = feedbackEmail(r as unknown as FeedbackReport, { first: c.name.split(" ")[0], job, site });
    // from the ai@beamore.co.uk mailbox itself once it's connected (Reports → Settings), else Ronan's Gmail sending as it
    const res = (await sendFromMailbox(admin, AI_MAILBOX, "Beamore AI", { to: c.email!, subject: e.subject, body: e.text, html: e.html }))
      ?? (await g.sendAutomaticAs({ email: AI_MAILBOX, name: "Beamore AI" }, { to: c.email!, subject: e.subject, body: e.text }));
    if (!res) return { sent, waiting: true }; // ai@ isn't connected yet: try again next time
    await queueEmail(admin, { kind: "ai-feedback", to: c.email!, subject: e.subject, body: e.text, clerkId: c.id, ref: r.id, status: "sent", note: "Sent automatically from ai@beamore.co.uk" });
    sent++;
  }
  return { sent, waiting: false };
}
