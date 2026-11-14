// Loads a local copy of the diary into the database (the same code the hourly Drive sync runs):
//   node --env-file=.env.local scripts/load-diary.mjs "G:\My Drive\Business\Beamore Management\Diary\Diary 2026.xlsx"
import path from "node:path";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";
import { parseDiary } from "../src/lib/sync/diary-parse.mjs";
import { writeDiary } from "../src/lib/sync/diary-write.mjs";

const file = process.argv[2];
const label = path.basename(file).replace(/^diary2026\.xlsx$/i, "Diary 2026.xlsx");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(file);
const t = Date.now();
const { data: run } = await admin.from("sync_runs").insert({ source: "diary" }).select("id").single();
try {
  const msg = await writeDiary(admin, parseDiary(wb, { fileLabel: label }), label);
  await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: true, message: `${msg} (loaded from this computer)` }).eq("id", run.id);
  console.log(msg, `| ${Date.now() - t}ms`);
} catch (e) {
  await admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok: false, message: e.message }).eq("id", run.id);
  throw e;
}
