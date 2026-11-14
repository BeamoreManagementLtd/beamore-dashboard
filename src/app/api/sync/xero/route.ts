import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { syncXero } from "@/lib/sync/xero-sync";

export const maxDuration = 300; // the first run fetches the whole financial year's invoices
export const dynamic = "force-dynamic";

/** Hourly Vercel cron (vercel.json). Vercel sends "Authorization: Bearer <CRON_SECRET>". */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const r = await syncXero(createServiceClient());
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
