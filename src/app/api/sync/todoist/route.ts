import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { syncTodoist } from "@/lib/todoist";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** Every 10 minutes (vercel.json): two-way link between the dashboard and Ronan's Todoist "Beamore" project. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const admin = createServiceClient();
  const { data: run } = await admin.from("sync_runs").insert({ source: "todoist" }).select("id").single();
  try {
    const r = await syncTodoist(admin);
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: r.ok, message: r.message }).eq("id", run?.id);
    return NextResponse.json(r);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message: m }).eq("id", run?.id);
    return NextResponse.json({ error: m }, { status: 500 });
  }
}
