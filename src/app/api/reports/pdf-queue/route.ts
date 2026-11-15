import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pdfQueue } from "@/lib/reports/pipeline";

export const dynamic = "force-dynamic";

/** For the Word helper on the office PC: approved reports waiting for their PDF. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const admin = createServiceClient();
  await admin.from("sync_files").upsert({ key: "word_helper", file_id: "pc", modified_time: new Date().toISOString(), read_at: new Date().toISOString() });
  return NextResponse.json({ jobs: await pdfQueue(admin) });
}
