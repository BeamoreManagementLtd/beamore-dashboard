import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { labelDiaryCompanies } from "@/lib/portal/diary-writer";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Daily (vercel.json): clerks' own company names in brackets under their names in the diary, November 2026 on. ?dry=1 only lists. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  try {
    return NextResponse.json(await labelDiaryCompanies(createServiceClient(), { write: request.nextUrl.searchParams.get("dry") !== "1" }));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
