import "server-only";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import type ExcelJS from "exceljs";
import { driveClient } from "@/lib/google";
import { loadWorkbook } from "@/lib/sync/load-workbook.mjs";
import { setCell, setColWidths, cellStyle } from "./diary-cells.mjs";
import { contactRows, CONTACT_HEADERS, CONTACT_COLS, type ContactClerk } from "./contact-sheet.mjs";

/**
 * Keeps the diary's "Contact details" tab up to date from the dashboard (Ronan, 15 Nov 2026): clerks' details from the
 * portal (next of kin, address, DBS, PPE...) and their companies go in columns F-K, new clerks are added, and the list is
 * kept in first-name order. Same care as the other diary writes: only that tab's cells change, nothing is written
 * while the diary was changed in the last 10 minutes, and Drive keeps the previous version. Every diary year that has
 * the tab is kept up to date.
 */
const SHEET = "Contact details";
const QUIET_MS = 10 * 60 * 1000;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const COL = "ABCDEFGHIJK";
const WIDTHS = { 6: 30, 7: 45, 8: 30, 9: 18, 10: 28, 11: 32 };
/** Portal events that mean the tab needs updating. */
const TRIGGERS = ["details-saved", "new-clerk-onboarded", "contacts-requested"];

const text = (c: ExcelJS.Cell) => {
  const v = c.value as unknown;
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { richText?: { text: string }[]; text?: string; result?: unknown; hyperlink?: string };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.text !== undefined) return String(o.text);
    return o.result == null ? "" : String(o.result);
  }
  return String(v);
};

async function clerksForTab(admin: SupabaseClient): Promise<ContactClerk[]> {
  const [{ data: clerks, error }, { data: links }] = await Promise.all([
    admin.from("clerks").select("id,name,email,personal_email,phone,active,clerk_compliance(address,next_of_kin_name,next_of_kin_relationship,next_of_kin_phone,emergency_contact,company_name,dbs_level,dbs_checked,dbs_update_service,ppe_notes,details_completed_at)").eq("active", true),
    admin.from("clerk_companies").select("clerk_id,company_name").eq("kind", "own").eq("status", "Enabled"),
  ]);
  if (error) throw new Error(error.message);
  return (clerks ?? []).map((c) => {
    const k = ([c.clerk_compliance].flat()[0] ?? null) as Record<string, string | boolean | null> | null;
    return {
      name: c.name, email: c.email, personal_email: c.personal_email, phone: c.phone, self_entered: !!k?.details_completed_at,
      companies: [...new Set((links ?? []).filter((l) => l.clerk_id === c.id).map((l) => l.company_name as string))], compliance: k,
    };
  });
}

export async function writeContactsTab(admin: SupabaseClient, { write = true } = {}) {
  const g = await driveClient(admin);
  const files: Record<string, string> = { ...(g.connection.diary_files ?? {}) };
  if (!files["2026"] && g.connection.diary_file_id) files["2026"] = g.connection.diary_file_id;
  const clerks = await clerksForTab(admin);
  const results: { year: string; changed: number; waiting?: boolean; note: string }[] = [];
  for (const year of Object.keys(files).sort()) results.push({ year, ...(await writeOne(admin, g, files[year], year, clerks, write)) });
  const changed = results.reduce((n, r) => n + r.changed, 0);
  const waiting = results.some((r) => r.waiting);
  if (write && !waiting) await admin.from("portal_audit").insert({ actor: "dashboard", action: "diary-contacts", detail: { results } });
  return { changed, waiting, note: results.map((r) => r.note).filter(Boolean).join("; ") };
}

/** From the 15-minute portal job: only when a clerk saved their details or was added since the tab was last updated. */
export async function writeContactsIfNeeded(admin: SupabaseClient) {
  const [{ data: ev }, { data: done }] = await Promise.all([
    admin.from("portal_audit").select("at").in("action", TRIGGERS).order("at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("portal_audit").select("at").eq("action", "diary-contacts").order("at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (!ev || (done && done.at > ev.at)) return null;
  return writeContactsTab(admin);
}

async function writeOne(admin: SupabaseClient, g: Awaited<ReturnType<typeof driveClient>>, fileId: string, year: string, clerks: ContactClerk[], write: boolean) {
  const meta = await g.json<{ modifiedTime: string; headRevisionId: string }>(`files/${fileId}`, { fields: "modifiedTime,headRevisionId", supportsAllDrives: "true" });
  if (write && Date.now() - Date.parse(meta.modifiedTime) < QUIET_MS) return { changed: 0, waiting: true, note: `Diary ${year} changed in the last 10 minutes; will try again shortly` };
  const raw = Buffer.from(await g.download(fileId));
  const wb = await loadWorkbook(raw);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) return { changed: 0, note: `Diary ${year} has no ${SHEET} tab` };

  // what's there now: rows 2.. down to the last row with a name in A or B
  const current: string[][] = [];
  for (let r = 2; r <= ws.rowCount; r++) current.push(Array.from({ length: CONTACT_COLS }, (_, i) => text(ws.getCell(r, i + 1)).trim()));
  let last = current.length;
  while (last > 0 && !current[last - 1][0] && !current[last - 1][1]) last--;
  const block = current.slice(0, last);
  const want = contactRows(block, clerks);
  if (want.length < block.filter((r) => r[0] || r[1]).length) throw new Error("Contact details: would lose rows, stopped");

  const changes: { ref: string; value: string; style?: string }[] = [];
  CONTACT_HEADERS.forEach((h, i) => { if (text(ws.getCell(1, i + 1)).trim() !== h) changes.push({ ref: `${COL[i]}1`, value: h }); });
  const rows = Math.max(want.length, last);
  for (let r = 0; r < rows; r++) {
    const w = want[r] ?? Array(CONTACT_COLS).fill("");
    const now = current[r] ?? Array(CONTACT_COLS).fill("");
    for (let i = 0; i < CONTACT_COLS; i++) if ((w[i] ?? "") !== (now[i] ?? "")) changes.push({ ref: `${COL[i]}${r + 2}`, value: w[i] ?? "" });
  }
  if (!changes.length) return { changed: 0, note: "" };
  if (!write) return { changed: changes.length, note: changes.map((c) => `${c.ref}=${c.value}`).join("; ") };

  const zip = await JSZip.loadAsync(raw);
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const rid = new RegExp(String.raw`<(?:\w+:)?sheet\b[^>]*name="${SHEET}"[^>]*r:id="([^"]+)"`).exec(wbXml)?.[1];
  const target = rid && (new RegExp(String.raw`<Relationship\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(String.raw`<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1]);
  if (!target) throw new Error(`can't find the ${SHEET} sheet inside the file`);
  const p = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  let xml = await zip.file(p)!.async("string");
  // styles: headers like A1, names and emails like A2, phones like the usual phone cell, the new columns like the names
  const head = cellStyle(xml, "A1")?.s, body = cellStyle(xml, "A2")?.s, phone = cellStyle(xml, "E3")?.s ?? body;
  for (const c of changes) {
    const col = c.ref[0], row = Number(c.ref.slice(1));
    const style = row === 1 ? head : col === "E" ? phone : body;
    xml = setCell(xml, c.ref, c.value, c.value ? style : undefined);
  }
  xml = setColWidths(xml, WIDTHS);
  zip.file(p, xml);
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const now = await g.json<{ headRevisionId: string }>(`files/${fileId}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  if (now.headRevisionId !== meta.headRevisionId) return { changed: 0, waiting: true, note: "The diary changed while preparing; will try again shortly" };
  await g.replaceContent(fileId, out, XLSX);
  const after = await g.json<{ md5Checksum: string }>(`files/${fileId}`, { fields: "md5Checksum", supportsAllDrives: "true" });
  if (after.md5Checksum !== createHash("md5").update(out).digest("hex")) throw new Error("The diary on Drive doesn't match what was saved");
  return { changed: changes.length, note: `Diary ${year}: ${changes.length} contact cells updated, ${want.length} people` };
}
