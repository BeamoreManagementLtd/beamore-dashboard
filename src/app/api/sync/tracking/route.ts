import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { setupProjectTracking } from "@/lib/xero-tracking";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Daily Vercel cron (vercel.json): Xero project tracking (Education / Other) rotated within 100 options each. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const r = await setupProjectTracking(createServiceClient());
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
