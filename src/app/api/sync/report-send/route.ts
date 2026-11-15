import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { sendReady } from "@/lib/reports/pipeline";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Every 5 minutes (vercel.json): approved reports whose Word PDF has reached Drive are emailed. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  try {
    return NextResponse.json({ sent: await sendReady(createServiceClient()) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
