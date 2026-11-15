import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { closeDoneTasks } from "@/lib/task-closer";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Hourly (vercel.json): ticks off to-dos that emails or dashboard updates show are done. ?since=ISO to look further back. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const admin = createServiceClient();
  const { data: run } = await admin.from("sync_runs").insert({ source: "task-closer" }).select("id").single();
  try {
    const r = await closeDoneTasks(admin, { sinceOverride: request.nextUrl.searchParams.get("since") ?? undefined });
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: r.ok, message: r.message }).eq("id", run?.id);
    return NextResponse.json(r);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message: m }).eq("id", run?.id);
    return NextResponse.json({ error: m }, { status: 500 });
  }
}
