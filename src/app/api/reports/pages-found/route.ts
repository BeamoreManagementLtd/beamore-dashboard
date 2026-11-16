import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pagesFound } from "@/lib/reports/pipeline";

export const dynamic = "force-dynamic";

/** The Word helper on the office PC: the page each of a report's points is on (or the error it hit). */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "no id" }, { status: 400 });
  const body = await request.json().catch(() => ({}));
  return NextResponse.json({ saved: await pagesFound(createServiceClient(), id, body) });
}
