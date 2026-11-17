import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { driveClient } from "@/lib/google";
import { recordReportFiles, type DriveFile } from "@/lib/reports/tracker";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Fills the report tracker with the report files (Word and PDF) that arrived between two dates, from Drive. For the
 * weeks before the tracker existed (17 Nov 2026); afterwards the 15-minute report scan records them. Director only.
 * POST { from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
 */
export async function POST(req: Request) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  const { data: me } = user ? await db.from("profiles").select("role").eq("id", user.id).maybeSingle() : { data: null };
  if (me?.role !== "director") return NextResponse.json({ error: "director only" }, { status: 403 });
  const { from, to } = (await req.json().catch(() => ({}))) as { from?: string; to?: string };
  if (!from || !to) return NextResponse.json({ error: "from and to needed" }, { status: 400 });
  const admin = createServiceClient();
  const g = await driveClient(admin);
  const q = `(mimeType='application/pdf' or mimeType='application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType='application/msword') and trashed=false and createdTime >= '${from}T00:00:00Z' and createdTime < '${to}T00:00:00Z'`;
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const r = await g.json<{ files: DriveFile[]; nextPageToken?: string }>("files", { q, fields: "nextPageToken,files(id,name,parents,createdTime,mimeType)", pageSize: "1000", includeItemsFromAllDrives: "true", supportsAllDrives: "true", ...(pageToken ? { pageToken } : {}) });
    files.push(...r.files); pageToken = r.nextPageToken;
  } while (pageToken);
  const added = await recordReportFiles(admin, g, files);
  return NextResponse.json({ looked_at: files.length, added });
}
