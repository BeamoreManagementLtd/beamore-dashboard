import { NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { driveClient } from "@/lib/google";

export const dynamic = "force-dynamic";

/**
 * Downloads a report's checked copy so it opens in Word (Ronan, 16 Nov 2026). Google's own download link gave "403:
 * you do not have access" whenever the browser was signed into a different Google account, so the dashboard fetches
 * the file through its own Drive connection and hands it over. Staff only (the sign-in check sends anyone else away).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireProfile();
  const { id } = await params;
  const admin = createServiceClient();
  const { data: r } = await admin.from("reports").select("checked_file_id,checked_name,file_name").eq("id", id).maybeSingle();
  if (!r?.checked_file_id) return NextResponse.json({ error: "This report has no checked copy" }, { status: 404 });
  const g = await driveClient(admin);
  const body = Buffer.from(await g.download(r.checked_file_id));
  const name = (r.checked_name ?? r.file_name ?? "report.docx").replace(/[\r\n"]/g, "");
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
