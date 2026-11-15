import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { driveClient } from "@/lib/google";
import { loadWorkbook } from "@/lib/sync/load-workbook.mjs";

/**
 * Keeps the numbering in one place: projects the dashboard creates (pricing requests turned into enquiries) get a row
 * at the bottom of Cost Proposals/Beamore Cost Proposals Register.xlsx ("Register" tab), in the same style as the
 * 14 Nov additions. Only appends; never edits or removes existing rows. Skipped while the file was changed in the last
 * 10 minutes (someone may have it open). Drive keeps the previous versions.
 */
const STAGE: Record<string, string> = {
  enquiry: "Enquiry", pricing: "Pricing", sent: "Sent – awaiting reply", won_arranging: "Won – arranging clerk",
  won_preparing: "Won – preparing to start", live: "Live", on_hold: "On hold", lost: "Lost", complete: "Complete",
};

export async function appendToRegister(admin: SupabaseClient) {
  const { data: todo } = await admin.from("projects").select("id,number,name,stage,created_at,details,clients(name)")
    .gt("number", 1341).order("number");
  const missing = (todo ?? []).filter((p) => !((p.details ?? {}) as Record<string, unknown>)._register);
  if (!missing.length) return 0;

  const g = await driveClient(admin);
  const FOLDER = "application/vnd.google-apps.folder";
  let at: string | undefined = "root";
  for (const step of ["Business", "Beamore Management", "Cost Proposals"]) {
    at = (await g.json<{ files: { id: string }[] }>("files", { q: `'${at}' in parents and name = '${step}' and mimeType = '${FOLDER}' and trashed = false`, fields: "files(id)" })).files[0]?.id;
    if (!at) throw new Error(`No "${step}" folder on the way to the register`);
  }
  const file = (await g.json<{ files: { id: string; modifiedTime: string }[] }>("files", { q: `'${at}' in parents and name = 'Beamore Cost Proposals Register.xlsx' and trashed = false`, fields: "files(id,modifiedTime)" })).files[0];
  if (!file) throw new Error("Beamore Cost Proposals Register.xlsx not found in Cost Proposals");
  if (Date.now() - Date.parse(file.modifiedTime) < 10 * 60e3) return 0; // being edited: try next hour

  const wb = (await loadWorkbook(Buffer.from(await g.download(file.id)))) as ExcelJS.Workbook;
  const ws = wb.getWorksheet("Register");
  if (!ws) throw new Error('No "Register" tab in the register');
  const refs = new Set<number>();
  let last = 4;
  for (let r = 5; r <= ws.rowCount; r++) {
    const m = /^BM-(\d+)/.exec(String(ws.getCell(r, 1).value ?? ""));
    if (m) { refs.add(Number(m[1])); last = r; }
  }
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  let added = 0;
  for (const p of missing) {
    if (refs.has(p.number)) { await admin.from("projects").update({ details: { ...((p.details ?? {}) as object), _register: true } }).eq("id", p.id); continue; }
    const r = ++last;
    const values = [`BM-${p.number}`, (p.clients as unknown as { name: string } | null)?.name ?? "", p.name, STAGE[p.stage] ?? "Enquiry",
      `Added by the dashboard ${today}: from a pricing request in email`, "Ronan"];
    values.forEach((v, i) => {
      const cell = ws.getCell(r, i + 1);
      cell.value = v;
      cell.style = { ...ws.getCell(r - 1, i + 1).style }; // same look as the row above
    });
    ws.getCell(r, 4).dataValidation = ws.getCell(r - 1, 4).dataValidation;
    added++;
  }
  if (added) {
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await g.replaceContent(file.id, buf, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }
  for (const p of missing) await admin.from("projects").update({ details: { ...((p.details ?? {}) as object), _register: true } }).eq("id", p.id);
  return added;
}
