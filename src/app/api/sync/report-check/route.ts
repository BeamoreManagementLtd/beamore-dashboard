import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { scanReports, checkWaiting } from "@/lib/reports/pipeline";

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
    const check = await checkWaiting(admin, 200_000);
    const message = `${scan.found} new reports, ${scan.done} now have a PDF; ${check.checked} checked${check.failed ? `, ${check.failed} failed` : ""}`;
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: !check.failed, message }).eq("id", run?.id);
    return NextResponse.json({ scan, check });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message: m }).eq("id", run?.id);
    return NextResponse.json({ error: m }, { status: 500 });
  }
}
