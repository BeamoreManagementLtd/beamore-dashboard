import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { syncProposalPlans } from "@/lib/sync/proposal-sync";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Daily Vercel cron (vercel.json): planned days by month from each active project's latest cost sheet. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const r = await syncProposalPlans(createServiceClient());
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
