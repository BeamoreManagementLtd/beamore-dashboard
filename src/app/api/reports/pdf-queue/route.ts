import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { pdfQueue } from "@/lib/reports/pipeline";

export const dynamic = "force-dynamic";

/** For the Word helper (on the Beamore server PC): approved reports waiting for their PDF. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const admin = createServiceClient();
  // which computer it is (the Beamore server from 16 Nov 2026), so the Reports page can say, and each PC is seen apart
  const pc = (request.headers.get("x-helper-pc") ?? "pc").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "pc";
  const now = new Date().toISOString();
  await admin.from("sync_files").upsert([{ key: "word_helper", file_id: pc, modified_time: now, read_at: now }, { key: `word_helper:${pc}`, file_id: pc, modified_time: now, read_at: now }]);
  return NextResponse.json({ jobs: await pdfQueue(admin) });
}
