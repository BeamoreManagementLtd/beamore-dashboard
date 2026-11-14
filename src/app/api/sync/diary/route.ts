import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { syncDiary } from "@/lib/sync/diary-sync";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Hourly Vercel cron (vercel.json). Skips quickly when the diary hasn't changed since the last read. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const r = await syncDiary(createServiceClient(), { force: request.nextUrl.searchParams.get("force") === "1" });
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
