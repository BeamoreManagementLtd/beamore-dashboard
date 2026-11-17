import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { sendFromMailbox, AI_MAILBOX } from "@/lib/google-user";

export const dynamic = "force-dynamic";

const OFFICE = /\b(checker|the office|office pc|fit to send|before (it is |it's )?sent|before sending|send it|invoice|fee|rate|ronan|judy|an[eé]l)\b/i;
type Part = { label: string; of: number; got: number; note?: string; improve?: string };

/**
 * An example of the AI feedback email, sent from ai@beamore.co.uk to the director only (Ronan, 17 Nov 2026: "send me
 * an example email from it with the feedback from Peter Bertans' reports"): the real email a clerk gets, then what
 * they'd see in the portal. Never sent to the clerk. POST { reportId }
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
  const f = (r.fixes ?? {}) as { spelling?: { find: string; replace: string }[]; uniform?: number; stretched?: number; shrunk?: number; renamed?: string | null; score_parts?: Part[] };
  const p = r.projects as unknown as { name?: string; display_name?: string } | null;
  const first = ((r.clerks as unknown as { name?: string } | null)?.name ?? "there").split(" ")[0];
  const job = p?.name ?? p?.display_name ?? "your job"; // the plain job name, without Beamore's job number
  const name = r.file_name.replace(/\.docx?$/i, "");
  const fixed = [
    f.spelling?.length ? `${f.spelling.length} spelling or typing slip${f.spelling.length === 1 ? "" : "s"} corrected (tracked changes in the Word file), e.g. ${f.spelling.slice(0, 3).map((s) => `"${s.find}" → "${s.replace}"`).join(", ")}` : "",
    f.uniform ? `${f.uniform} photos set to the same size` : "", f.stretched ? `${f.stretched} stretched photos put back to shape` : "",
    f.shrunk ? `${f.shrunk} photos made smaller in file size` : "", f.renamed ? `File name changed to: ${f.renamed.replace(/\.docx?$/i, "")}` : "",
  ].filter(Boolean);
  const points = ((r.clerk_points ?? []) as string[]).filter((t) => !OFFICE.test(t));
  const parts = (f.score_parts ?? []).filter((x) => x.of > 0);
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://dashboard.beamore.co.uk";
  const body = [
    `Hi ${first}`,
    `The AI feedback on your report (${name}) is ready to see in the clerk portal${r.score !== null ? `. It scored ${Math.round(Number(r.score))} out of 100` : ""}:`,
    `${site}/portal/reports/${r.id}`,
    "It's AI feedback based on what Beamore asks for in a report, so please don't take it all to heart: AI can make mistakes, and some points may not apply to your job.",
    "You can switch these emails and the feedback off at any time under Your reports in the portal.",
    "Beamore Management",
    "",
    "------------------------------------------------------------",
    `EXAMPLE ONLY (for Ronan): what ${first} would see when they click the link`,
    "------------------------------------------------------------",
    `${job}: ${name}`,
    `SCORE: ${r.score !== null ? Math.round(Number(r.score)) : "?"} out of 100`,
    parts.map((x) => `- ${x.label}: ${Math.round(x.got * 10) / 10} of ${x.of}. ${x.note ?? ""}${x.improve ? `\n    Tip: ${x.improve}` : ""}`).join("\n"),
    `WHAT WAS FIXED FOR YOU\n${fixed.length ? fixed.map((x) => `- ${x}`).join("\n") : "- Nothing needed fixing."}`,
    `SUGGESTIONS\n${points.length ? points.map((x) => `- ${x}`).join("\n") : "- None this time."}`,
    "(Plus a graph of their scores over time, and a link to the PDF that was sent.)",
  ].join("\n\n");
  const sent = await sendFromMailbox(admin, AI_MAILBOX, "Beamore AI", { to: me.email, subject: `[Example] AI feedback on your ${job} report`, body });
  if (!sent) return NextResponse.json({ error: "ai@beamore.co.uk isn't connected" }, { status: 400 });
  return NextResponse.json({ sent: true, to: me.email, report: r.file_name });
}
