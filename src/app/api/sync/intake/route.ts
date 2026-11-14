import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runIntake } from "@/lib/sync/intake";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Hourly Vercel cron (vercel.json): DfE or not, automatic checklists, checklist items found in email, go-aheads. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const r = await runIntake(createServiceClient());
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
