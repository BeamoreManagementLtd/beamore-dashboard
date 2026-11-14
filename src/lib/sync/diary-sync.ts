import "server-only";
import ExcelJS from "exceljs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { parseDiary } from "@/lib/sync/diary-parse.mjs";
import { writeDiary } from "@/lib/sync/diary-write.mjs";

const FILE_NAME = process.env.DIARY_FILE_NAME ?? "Diary 2026.xlsx";

/** The master diary is "Diary 2026.xlsx" in the "Diary" folder (never a copy elsewhere). */
async function findDiary(drive: Awaited<ReturnType<typeof driveClient>>) {
  if (process.env.DIARY_FILE_ID) return process.env.DIARY_FILE_ID;
  const { files } = await drive.json<{ files: { id: string; parents?: string[] }[] }>("files", {
    q: `name = '${FILE_NAME}' and trashed = false`, fields: "files(id,parents)", pageSize: "20",
    includeItemsFromAllDrives: "true", supportsAllDrives: "true",
  });
  for (const f of files) {
    const parent = f.parents?.[0] && (await drive.json<{ name: string }>(`files/${f.parents[0]}`, { fields: "name", supportsAllDrives: "true" }));
    if (parent && parent.name === "Diary") return f.id;
  }
  throw new Error(`Couldn't find "${FILE_NAME}" in a folder called Diary on Google Drive`);
}

/** Downloads the diary from Drive (only when it has changed, unless forced) and loads it into the database. */
export async function syncDiary(admin: SupabaseClient, { force = false } = {}) {
  const { data: run } = await admin.from("sync_runs").insert({ source: "diary" }).select("id").single();
  const finish = (ok: boolean, message: string) =>
    admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const drive = await driveClient(admin);
    const fileId = drive.connection.diary_file_id ?? (await findDiary(drive));
    const meta = await drive.json<{ modifiedTime: string; name: string }>(`files/${fileId}`, { fields: "modifiedTime,name", supportsAllDrives: "true" });
    if (!force && meta.modifiedTime === drive.connection.diary_modified_time) {
      await finish(true, "Diary unchanged since last read");
      return { ok: true, message: "Diary unchanged since last read" };
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await drive.download(fileId));
    const msg = await writeDiary(admin, parseDiary(wb, { fileLabel: meta.name }), meta.name);
    await admin.from("google_connection").update({ diary_file_id: fileId, diary_modified_time: meta.modifiedTime }).eq("id", 1);
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finish(false, msg);
    return { ok: false, message: msg };
  }
}
