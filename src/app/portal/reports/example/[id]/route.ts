import { NextResponse } from "next/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { driveClient } from "@/lib/google";
import { reportExamples } from "@/lib/reports/top-examples";

export const dynamic = "force-dynamic";

/** Downloads one of the example reports' PDFs for a clerk (only the reports currently shown as examples). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requirePortalUser();
  const { id } = await params;
  const admin = createServiceClient();
  const ex = (await reportExamples(admin)).find((e) => e.id === id);
  if (!ex) return NextResponse.json({ error: "That report isn't one of the examples" }, { status: 404 });
  const { data: r } = await admin.from("reports").select("pdf_file_id").eq("id", id).single();
  const body = Buffer.from(await (await driveClient(admin)).download(r!.pdf_file_id!));
  const name = ex.pdfName.replace(/[\r\n"]/g, "");
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "no-store",
    },
  });
}
