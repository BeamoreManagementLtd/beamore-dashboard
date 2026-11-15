import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pdfMade } from "@/lib/reports/pipeline";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/** The Word helper on the office PC: "I've saved the PDF for this report" (or the error it hit). */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "no id" }, { status: 400 });
  try {
    const sent = await pdfMade(createServiceClient(), id, request.nextUrl.searchParams.get("error"));
    return NextResponse.json({ sent });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
