import "server-only";
import ExcelJS from "exceljs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { parseDiary } from "@/lib/sync/diary-parse.mjs";
import { writeDiary } from "@/lib/sync/diary-write.mjs";

/**
 * The master diaries are "Diary 2026.xlsx", "Diary 2027.xlsx"… in the "Diary" folder (never copies elsewhere, never the
 * Archive). Every year from 2026 is read; a new year's file is picked up automatically once it's created.
 */
export async function findDiaries(drive: Awaited<ReturnType<typeof driveClient>>) {
  const { files } = await drive.json<{ files: { id: string; name: string; parents?: string[] }[] }>("files", {
    q: "name contains 'Diary 20' and trashed = false", fields: "files(id,name,parents)", pageSize: "50",
    includeItemsFromAllDrives: "true", supportsAllDrives: "true",
  });
  const out: Record<string, string> = {};
  const parentName = new Map<string, string>();
  for (const f of files) {
    const y = /^Diary (20\d\d)\.xlsx$/i.exec(f.name)?.[1];
    if (!y || Number(y) < 2026 || !f.parents?.[0]) continue;
    if (!parentName.has(f.parents[0])) parentName.set(f.parents[0], (await drive.json<{ name: string }>(`files/${f.parents[0]}`, { fields: "name", supportsAllDrives: "true" })).name);
    if (parentName.get(f.parents[0]) === "Diary") out[y] = f.id;
  }
  if (!out["2026"]) throw new Error(`Couldn't find "Diary 2026.xlsx" in a folder called Diary on Google Drive`);
  return out;
}

/** Downloads the diaries from Drive (only when one has changed, unless forced) and loads them into the database. */
export async function syncDiary(admin: SupabaseClient, { force = false } = {}) {
  const { data: run } = await admin.from("sync_runs").insert({ source: "diary" }).select("id").single();
  const finish = (ok: boolean, message: string) =>
    admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const drive = await driveClient(admin);
    const files = await findDiaries(drive);
    const years = Object.keys(files).sort();
    const metas = await Promise.all(years.map((y) => drive.json<{ modifiedTime: string; name: string }>(`files/${files[y]}`, { fields: "modifiedTime,name", supportsAllDrives: "true" })));
    const stamp = years.map((y, i) => `${y}:${metas[i].modifiedTime}`).join("|");
    if (!force && stamp === drive.connection.diary_modified_time) {
      await finish(true, "Diary unchanged since last read");
      return { ok: true, message: "Diary unchanged since last read" };
    }
    // visits, holidays and invoice tables come from every year; the other tabs (rates, emails, POs, contacts) from the
    // newest diary, falling back to older ones for anything it doesn't have yet
    type Parsed = ReturnType<typeof parseDiary> & { reportEmails: unknown[]; invoicePOs: unknown[]; contactDetails: unknown[]; projectsTab: unknown[] };
    const parsed: Parsed[] = [];
    for (let i = 0; i < years.length; i++) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await drive.download(files[years[i]]));
      parsed.push(parseDiary(wb, { year: Number(years[i]), fileLabel: metas[i].name }) as Parsed);
    }
    const newestFirst = [...parsed].reverse();
    const pick = <K extends keyof Parsed>(k: K): Parsed[K] => newestFirst.find((p) => (p[k] as unknown[]).length)?.[k] ?? parsed[0][k];
    const merged = {
      visits: parsed.flatMap((p) => p.visits), absences: parsed.flatMap((p) => p.absences), invoiceLines: parsed.flatMap((p) => p.invoiceLines),
      rates: newestFirst.flatMap((p) => p.rates), clerks: [...new Set(parsed.flatMap((p) => p.clerks))],
      invoiceEmails: pick("invoiceEmails"), reportEmails: pick("reportEmails"), invoicePOs: pick("invoicePOs"), contactDetails: pick("contactDetails"), projectsTab: pick("projectsTab"),
    };
    const msg = await writeDiary(admin, merged as unknown as Parameters<typeof writeDiary>[1], "Diary 20") + (years.length > 1 ? ` (diaries ${years.join(" and ")})` : "");
    await admin.from("google_connection").update({ diary_file_id: files["2026"], diary_files: files, diary_modified_time: stamp }).eq("id", 1);
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finish(false, msg);
    return { ok: false, message: msg };
  }
}
