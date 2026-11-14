import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { syncReports } from "@/lib/sync/reports-sync";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** Vercel cron every 30 minutes (vercel.json). Skips quickly when neither report file has changed. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const r = await syncReports(createServiceClient());
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
