import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { syncProjectDetails } from "@/lib/sync/details-sync";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Daily Vercel cron (vercel.json): project details from the newest CoW diary front page. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const r = await syncProjectDetails(createServiceClient());
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
