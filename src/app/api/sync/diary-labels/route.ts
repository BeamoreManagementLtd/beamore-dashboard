import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { labelDiaryCompanies } from "@/lib/portal/diary-writer";
import { writeContactsTab } from "@/lib/portal/contacts-writer";
import { writeProjectsTab } from "@/lib/portal/projects-writer";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Daily (vercel.json): clerks' own company names in brackets under their names in the diary, November 2026 on, and the
 * Contact details and Projects tabs brought up to date. ?dry=1 only lists.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  try {
    const admin = createServiceClient(), write = request.nextUrl.searchParams.get("dry") !== "1";
    const labels = await labelDiaryCompanies(admin, { write });
    const contacts = await writeContactsTab(admin, { write });
    // new jobs and their details into the Projects tab (the diary was maybe just saved above, so it may wait a day)
    const projects = await writeProjectsTab(admin, { write }).catch((e) => ({ changed: 0, note: e instanceof Error ? e.message : String(e) }));
    return NextResponse.json({ ...labels, contacts, projects });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
