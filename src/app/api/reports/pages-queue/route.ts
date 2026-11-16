import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pagesQueue } from "@/lib/reports/pipeline";

export const dynamic = "force-dynamic";

/** For the Word helper on the office PC: checked reports whose points need page numbers. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  return NextResponse.json({ jobs: await pagesQueue(createServiceClient()) });
}
