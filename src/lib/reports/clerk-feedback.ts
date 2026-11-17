import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * AI feedback ready (Ronan, 17 Nov 2026): a clerk who has switched on AI feedback in the portal gets a short email from
 * ai@beamore.co.uk when one of their reports has been sent and its feedback is there to see. Once per report. Nothing
 * is sent while Ronan's Gmail can't send as ai@beamore.co.uk (it never goes from Ronan's own address instead).
 */
export async function notifyAiFeedback(admin: SupabaseClient) {
  const { data: clerks } = await admin.from("clerks").select("id,name,email,active").eq("ai_feedback", true);
  const on = (clerks ?? []).filter((c) => c.email && c.active);
  if (!on.length) return { sent: 0, waiting: false };
  const { data: reps } = await admin.from("reports").select("id,clerk_id,file_name,score,projects(name,display_name)")
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
    const job = p?.display_name ?? p?.name ?? "your job";
    const subject = `AI feedback on your ${job} report`;
    const body = [
      `Hi ${c.name.split(" ")[0]}`,
      `The AI feedback on your report (${r.file_name.replace(/\.docx?$/i, "")}) is ready to see in the clerk portal${r.score !== null && r.score !== undefined ? `. It scored ${Math.round(Number(r.score))} out of 100` : ""}:`,
      `${site}/portal/reports/${r.id}`,
      `It's AI feedback based on what Beamore asks for in a report, so please don't take it all to heart: AI can make mistakes, and some points may not apply to your job.`,
      `You can switch these emails and the feedback off at any time under Your reports in the portal.`,
      `Beamore Management`,
    ].join("\n\n");
    // from the ai@beamore.co.uk mailbox itself once it's connected (Reports → Settings), else Ronan's Gmail sending as it
    const res = (await sendFromMailbox(admin, AI_MAILBOX, "Beamore AI", { to: c.email!, subject, body })) ?? (await g.sendAutomaticAs({ email: AI_MAILBOX, name: "Beamore AI" }, { to: c.email!, subject, body }));
    if (!res) return { sent, waiting: true }; // ai@ isn't connected yet: try again next time
    await queueEmail(admin, { kind: "ai-feedback", to: c.email!, subject, body, clerkId: c.id, ref: r.id, status: "sent", note: "Sent automatically from ai@beamore.co.uk" });
    sent++;
  }
  return { sent, waiting: false };
}
