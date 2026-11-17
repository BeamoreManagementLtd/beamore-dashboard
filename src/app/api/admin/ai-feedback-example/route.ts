import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendFromMailbox, AI_MAILBOX } from "@/lib/google-user";
import { feedbackEmail, type FeedbackReport } from "@/lib/reports/feedback-email";

export const dynamic = "force-dynamic";

/**
 * An example of the AI feedback email, sent from ai@beamore.co.uk to the director only (Ronan, 17 Nov 2026), exactly
 * as the clerk would get it, with a note at the top that it's an example. Never sent to the clerk. POST { reportId }
 */
export async function POST(req: Request) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  const { data: me } = user ? await db.from("profiles").select("role,email").eq("id", user.id).maybeSingle() : { data: null };
  if (me?.role !== "director") return NextResponse.json({ error: "director only" }, { status: 403 });
  const { reportId } = (await req.json().catch(() => ({}))) as { reportId?: string };
  const admin = createServiceClient();
  const { data: r } = await admin.from("reports").select("id,file_name,score,clerk_points,fixes,clerks(name),projects(name,display_name)").eq("id", reportId ?? "").maybeSingle();
  if (!r) return NextResponse.json({ error: "no such report" }, { status: 404 });
  const p = r.projects as unknown as { name?: string; display_name?: string } | null;
  const clerk = (r.clerks as unknown as { name?: string } | null)?.name ?? "the clerk";
  const job = p?.name ?? p?.display_name ?? "your job"; // the plain job name, without Beamore's job number
  const e = feedbackEmail(r as unknown as FeedbackReport, {
    first: clerk.split(" ")[0], job, site: process.env.NEXT_PUBLIC_SITE_URL ?? "https://dashboard.beamore.co.uk",
    example: `Example for Ronan: this is the email ${clerk} would get. It hasn't been sent to them.`,
  });
  const sent = await sendFromMailbox(admin, AI_MAILBOX, "Beamore AI", { to: me.email, subject: e.subject, body: e.text, html: e.html });
  if (!sent) return NextResponse.json({ error: "ai@beamore.co.uk isn't connected" }, { status: 400 });
  return NextResponse.json({ sent: true, to: me.email, report: r.file_name });
}
