import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { processPending } from "@/lib/portal/process";
import { writePendingToDiary } from "@/lib/portal/diary-writer";
import { writeContactsIfNeeded } from "@/lib/portal/contacts-writer";
import { writeProjectsTab } from "@/lib/portal/projects-writer";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Every 15 minutes (vercel.json): files and reads any portal upload that didn't finish straight after upload. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const admin = createServiceClient();
  const { data: run } = await admin.from("sync_runs").insert({ source: "portal" }).select("id").single();
  try {
    const r = await processPending(admin);
    const diary = await writePendingToDiary(admin);
    // a clerk saved their details or a new clerk was added: the diary's Contact details tab
    const contacts = await writeContactsIfNeeded(admin).catch((e) => ({ changed: 0, waiting: false, note: e instanceof Error ? e.message : String(e) }));
    // email list changes made on the dashboard that aren't in the diary's Projects tab yet
    const { count: listChanges } = await admin.from("projects").select("id", { count: "exact", head: true }).not("details->_lists_pending", "is", null);
    if (listChanges) await writeProjectsTab(admin).catch(() => undefined);
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: r.failed === 0, message: `${r.done} processed, ${r.failed} failed, ${diary} invoices written to the diary${contacts ? `, contact details: ${contacts.note || "no change"}` : ""}` }).eq("id", run?.id);
    return NextResponse.json({ ...r, diary, contacts });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message: m }).eq("id", run?.id);
    return NextResponse.json({ error: m }, { status: 500 });
  }
}
