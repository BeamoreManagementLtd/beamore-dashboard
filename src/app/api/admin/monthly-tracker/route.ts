import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { driveClient } from "@/lib/google";
import { readReport, trackerItems } from "@/lib/reports/docx.mjs";
import { isMonthly, lastDiaryOfMonth, compareTrackers, trackerGapText } from "@/lib/reports/monthly";
import { askToUpdateMonthlyTracker } from "@/lib/reports/pipeline";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Catch-up for monthly reports already checked before the tracker check existed (Ronan, 17 Nov 2026: "send it straight
 * out to anyone"): compares each monthly report since `since` with the last weekly diary of its month and, with
 * send: true, emails the clerk (once per report, from Ronan's Gmail). Director only. POST { since: "YYYY-MM-DD", send?: boolean }
 */
export async function POST(req: Request) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  const { data: me } = user ? await db.from("profiles").select("role").eq("id", user.id).maybeSingle() : { data: null };
  if (me?.role !== "director") return NextResponse.json({ error: "director only" }, { status: 403 });
  const admin = createServiceClient();
  const { since, send } = (await req.json().catch(() => ({}))) as { since?: string; send?: boolean };
  const { data: reps } = await admin.from("reports").select("id,project_id,kind,file_name,folder_name,drive_file_id,uploaded_at,clerk_id,clerks(name,email)")
    .gte("uploaded_at", since ?? new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)).order("uploaded_at");
  const g = await driveClient(admin);
  const out: { report: string; clerk: string | null; email: string | null; against: string | null; text: string | null; sent: boolean }[] = [];
  for (const r of (reps ?? []).filter(isMonthly)) {
    const clerk = r.clerks as unknown as { name?: string; email?: string } | null;
    try {
      const last = await lastDiaryOfMonth(admin, r);
      if (!last) continue;
      const mr = await readReport(Buffer.from(await g.download(r.drive_file_id)));
      const gap = compareTrackers(trackerItems(mr), trackerItems(await readReport(Buffer.from(await g.download(last.drive_file_id)))), mr.paragraphs.map((x) => x.text));
      const text = trackerGapText(gap, last.file_name);
      if (!text) continue;
      const sent = send ? await askToUpdateMonthlyTracker(admin, r, { against: last.file_name, details: gap.details }) : false;
      out.push({ report: r.file_name, clerk: clerk?.name ?? null, email: clerk?.email ?? null, against: last.file_name, text, sent });
    } catch (e) { out.push({ report: r.file_name, clerk: clerk?.name ?? null, email: null, against: null, text: `failed: ${e instanceof Error ? e.message : e}`, sent: false }); }
  }
  return NextResponse.json({ flagged: out.length, out });
}
