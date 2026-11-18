import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { scanReports, checkWaiting } from "@/lib/reports/pipeline";
import { chaseMissing } from "@/lib/reports/tracker";
import { notifyAiFeedback } from "@/lib/reports/clerk-feedback";
import { loadHolidays } from "@/lib/reports/days";
import { precheckWaiting } from "@/lib/reports/precheck";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Every 15 minutes (vercel.json): finds new Word reports in the project folders, then checks the ones clerks have finished. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const admin = createServiceClient();
  const { data: run } = await admin.from("sync_runs").insert({ source: "report-check" }).select("id").single();
  try {
    const scan = await scanReports(admin);
    // clerks' checks before uploading that didn't finish straight away (the page was closed, say)
    const pre = await precheckWaiting(admin, 60_000).catch(() => 0);
    const check = await checkWaiting(admin, 170_000);
    // missing reports chased by email (only if switched on), on weekdays between 9 and 5 UK time
    const uk = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", hour: "numeric", hour12: false, weekday: "short" });
    const working = !/Sat|Sun/.test(uk) && +(/\d+/.exec(uk)?.[0] ?? 0) >= 9 && +(/\d+/.exec(uk)?.[0] ?? 0) < 17;
    const chased = working ? await chaseMissing(admin, new Date().toISOString().slice(0, 10), await loadHolidays()).catch(() => 0) : 0;
    // clerks who chose to see their AI feedback: an email from ai@beamore.co.uk when a report's feedback is ready
    const fb = working ? await notifyAiFeedback(admin).catch(() => ({ sent: 0, waiting: false })) : { sent: 0, waiting: false };
    const message = `${scan.found} new reports, ${scan.done} now have a PDF; ${check.checked} checked${check.failed ? `, ${check.failed} failed` : ""}${chased ? `; ${chased} clerk${chased === 1 ? "" : "s"} chased for missing reports` : ""}${fb.sent ? `; ${fb.sent} AI feedback email${fb.sent === 1 ? "" : "s"}` : ""}${fb.waiting ? "; AI feedback emails waiting: Gmail can't send as ai@beamore.co.uk yet" : ""}${pre ? `; ${pre} clerk pre-check${pre === 1 ? "" : "s"} finished` : ""}`;
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: !check.failed, message }).eq("id", run?.id);
    return NextResponse.json({ scan, check });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message: m }).eq("id", run?.id);
    return NextResponse.json({ error: m }, { status: 500 });
  }
}
