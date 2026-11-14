import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { loadWorkbook } from "@/lib/sync/load-workbook.mjs";
import { parseQueue, parseLog } from "@/lib/sync/reports-parse.mjs";
import { writeQueue, writeLog } from "@/lib/sync/reports-write.mjs";

// Both files are found by name; set the IDs in Vercel to pin them if a copy ever appears elsewhere.
const FILES = {
  report_queue: { id: process.env.REPORT_QUEUE_FILE_ID ?? "11qk6dYpRy0jCekeOoQSakVNEMq28bdXIoadIP9tHHxc", name: "Beamore Reports Ready To Check", sheet: true },
  report_log: { id: process.env.REPORT_LOG_FILE_ID ?? null, name: "Beamore Report Turnaround Dashboard.xlsx", sheet: false },
} as const;

/** Reads the Ready To Check sheet and the turnaround workbook from Drive when they've changed since the last read. */
export async function syncReports(admin: SupabaseClient, { force = false } = {}) {
  const { data: run } = await admin.from("sync_runs").insert({ source: "reports" }).select("id").single();
  const finish = (ok: boolean, message: string) =>
    admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const drive = await driveClient(admin);
    const { data: seen } = await admin.from("sync_files").select("*");
    const parts: string[] = [];
    for (const [key, f] of Object.entries(FILES)) {
      let id: string | null = seen?.find((s) => s.key === key)?.file_id ?? f.id;
      if (!id) {
        const { files } = await drive.json<{ files: { id: string }[] }>("files", {
          q: `name = '${f.name}' and trashed = false`, fields: "files(id)", orderBy: "modifiedTime desc", pageSize: "5",
          includeItemsFromAllDrives: "true", supportsAllDrives: "true",
        });
        id = files[0]?.id ?? null;
        if (!id) { parts.push(`couldn't find "${f.name}" on Drive`); continue; }
      }
      const meta = await drive.json<{ modifiedTime: string }>(`files/${id}`, { fields: "modifiedTime", supportsAllDrives: "true" });
      if (!force && seen?.find((s) => s.key === key)?.modified_time === meta.modifiedTime) continue;
      const wb = await loadWorkbook(f.sheet ? await drive.exportXlsx(id) : await drive.download(id));
      parts.push(key === "report_queue" ? await writeQueue(admin, parseQueue(wb), meta.modifiedTime) : await writeLog(admin, parseLog(wb)));
      await admin.from("sync_files").upsert({ key, file_id: id, modified_time: meta.modifiedTime, read_at: new Date().toISOString() });
    }
    const msg = parts.length ? parts.join("; ") : "Report files unchanged since last read";
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finish(false, msg);
    return { ok: false, message: msg };
  }
}
