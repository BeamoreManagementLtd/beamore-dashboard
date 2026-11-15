import "server-only";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import type ExcelJS from "exceljs";
import { driveClient } from "@/lib/google";
import { loadWorkbook } from "@/lib/sync/load-workbook.mjs";
import { setCell } from "./diary-cells.mjs";
import { sheetPath } from "./xlsx-sheet.mjs";

/**
 * Keeps the diary's "Projects" tab up to date from the dashboard (Ronan, 15 Nov 2026):
 *  - a running job that isn't on the tab yet goes in the first spare row under its client (or a spare row at the
 *    bottom for a new client), with its numbers, invoice and report contacts and clerk
 *  - rows with a job number get their Status kept current, and empty cells filled in from the dashboard
 * Anything typed into a cell is never overwritten. Same care as the other diary writes: only that tab's cells change,
 * nothing is written while the diary was changed in the last 10 minutes, and Drive keeps the previous version.
 */
const SHEET = "Projects";
const QUIET_MS = 10 * 60 * 1000;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const RUNNING = ["live", "won_arranging", "won_preparing", "on_hold"];
const STAGE: Record<string, string> = { live: "Live", complete: "Finished", won_arranging: "Starting", won_preparing: "Starting", on_hold: "On hold", lost: "Lost", enquiry: "Quote", sent: "Quote" };
const COLS = ["Company", "Project", "Project number", "DfE project number", "PO number", "Send invoice to", "CC on invoice", "Invoicing instructions", "Clerk of works", "Send reports to", "CC on reports", "Status", "Job no."] as const;
type Col = (typeof COLS)[number];

const key = (s: unknown) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/\b(the|school|academy|primary|college|ltd|limited)\b/g, "").replace(/[^a-z0-9]/g, "");
const text = (c: ExcelJS.Cell) => {
  const v = c.value as unknown;
  if (v == null) return "";
  if (typeof v === "object" && !(v instanceof Date)) { const o = v as { richText?: { text: string }[]; text?: string; result?: unknown }; return String(o.richText ? o.richText.map((t) => t.text).join("") : o.text ?? o.result ?? ""); }
  return String(v).trim();
};
const letter = (i: number) => String.fromCharCode(65 + i);
const emails = (s: unknown) => [...new Set((String([s].flat().join(";")).match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []))].join("; ");

export async function writeProjectsTab(admin: SupabaseClient, { write = true } = {}) {
  const g = await driveClient(admin);
  const files: Record<string, string> = { ...(g.connection.diary_files ?? {}) };
  if (!files["2026"] && g.connection.diary_file_id) files["2026"] = g.connection.diary_file_id;
  const [{ data: projects, error }, { data: clerks }, { data: contacts }] = await Promise.all([
    admin.from("projects").select("id,number,client_id,display_name,stage,po_number,dfe_project_number,report_to,report_cc,clerk_id,clerk_me_id,details,clients(name)"),
    admin.from("clerks").select("id,name"),
    admin.from("invoice_contacts").select("project_id,client_id,to_emails,cc_emails,notes"),
  ]);
  if (error) throw new Error(error.message);
  const clerkName = new Map((clerks ?? []).map((c) => [c.id, c.name as string]));
  const results: { year: string; changed: number; waiting?: boolean; note: string }[] = [];
  // the newest diary is the one people work in; older years keep their tab as it was
  const year = Object.keys(files).sort().at(-1);
  let copied: string[] = [];
  if (year) { const r = await writeOne(g, files[year], year, projects ?? [], clerkName, contacts ?? [], write); copied = r.copied ?? []; results.push({ year, changed: r.changed, waiting: r.waiting, note: r.note }); }
  // email list changes made on the dashboard are now in the diary: the diary sync can read those projects again
  // (only if nobody changed the lists again meanwhile)
  if (write) for (const id of copied) {
    const started = (((projects ?? []).find((x) => x.id === id)?.details ?? {}) as { _lists_pending?: { at?: string } })._lists_pending?.at;
    const { data: now } = await admin.from("projects").select("details").eq("id", id).single();
    const d = (now?.details ?? {}) as Record<string, unknown> & { _lists_pending?: { at?: string } };
    if (d._lists_pending?.at !== started) continue;
    const rest = { ...d };
    delete rest._lists_pending;
    await admin.from("projects").update({ details: rest }).eq("id", id);
  }
  const changed = results.reduce((n, r) => n + r.changed, 0);
  if (write && changed) await admin.from("portal_audit").insert({ actor: "dashboard", action: "diary-projects", detail: { results } });
  return { changed, note: results.map((r) => r.note).filter(Boolean).join("; ") };
}

type P = { id: string; number: number | null; client_id: string | null; display_name: string; stage: string; po_number: string | null; dfe_project_number: string | null; report_to: string | null; report_cc: string | null; clerk_id: string | null; clerk_me_id: string | null; details: unknown; clients: unknown };
const listsPending = (p: P) => (p.details as Record<string, unknown> | null)?._lists_pending as { invoice?: boolean } | undefined;
type IC = { project_id: string | null; client_id: string | null; to_emails: unknown; cc_emails: unknown; notes: string | null };

async function writeOne(g: Awaited<ReturnType<typeof driveClient>>, fileId: string, year: string, projects: P[], clerkName: Map<string, string>, contacts: IC[], write: boolean) {
  const meta = await g.json<{ modifiedTime: string; headRevisionId: string }>(`files/${fileId}`, { fields: "modifiedTime,headRevisionId", supportsAllDrives: "true" });
  if (write && Date.now() - Date.parse(meta.modifiedTime) < QUIET_MS) return { changed: 0, waiting: true, note: `Diary ${year} changed in the last 10 minutes; will try again later` };
  const raw = Buffer.from(await g.download(fileId));
  const ws = (await loadWorkbook(raw)).getWorksheet(SHEET);
  if (!ws) return { changed: 0, note: `Diary ${year} has no ${SHEET} tab` };

  // columns by their heading, so moving a column doesn't break anything
  const at = new Map<Col, number>();
  ws.getRow(1).eachCell((c, n) => { const h = text(c) as Col; if (COLS.includes(h)) at.set(h, n - 1); });
  if (!at.has("Company") || !at.has("Project") || !at.has("Job no.")) return { changed: 0, note: `The ${SHEET} tab's headings have changed; not updated` };
  // the company is written once, at the top of its block (Ronan, 15 Nov 2026): a row belongs to the company above it
  // until three empty rows in a row (its spare rows) end the block; rows after that are free for new clients
  const rows: { r: number; v: Record<string, string>; company: string }[] = [];
  let company = "", empties = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const v: Record<string, string> = {};
    for (const [h, i] of at) v[h] = text(ws.getCell(r, i + 1));
    if (v.Company) { company = v.Company; empties = 0; }
    else if (!v.Project) { if (++empties > 3) company = ""; } else empties = 0;
    rows.push({ r, v, company });
  }

  const changes: { ref: string; value: string }[] = [];
  const set = (row: { r: number; v: Record<string, string> }, h: Col, value: string, overwrite = false) => {
    const i = at.get(h);
    // an empty value only ever replaces something when overwriting (someone taken off an email list)
    if (i == null || row.v[h] === value || (!value && !overwrite) || (row.v[h] && !overwrite)) return;
    changes.push({ ref: `${letter(i)}${row.r}`, value });
    row.v[h] = value;
  };
  const clerkOf = (p: P) => (p.clerk_id && p.clerk_id === p.clerk_me_id ? `${clerkName.get(p.clerk_id)} (building and M&E)`
    : [p.clerk_id && clerkName.get(p.clerk_id), p.clerk_me_id && `${clerkName.get(p.clerk_me_id)} (M&E)`].filter(Boolean).join(", "));
  const fill = (row: { r: number; v: Record<string, string> }, p: P) => {
    set(row, "Status", STAGE[p.stage] ?? p.stage, true);
    set(row, "Job no.", p.number ? String(p.number) : "");
    // numbers only when they have a digit in them (the dashboard has a few bare "SRP" / "number" values)
    // real DfE numbers (SRP1234, FS0433, FE016, PSBP2226) go in their column; anything else is the client's own number
    const n = (p.dfe_project_number ?? "").trim();
    if (/^(SRP|FS|FE|PSBP)\s?\d{3,4}$/i.test(n) && at.has("DfE project number")) set(row, "DfE project number", n.replace(/\s/g, "").toUpperCase());
    else if (/\d/.test(n)) set(row, "Project number", n);
    if (/\d/.test(p.po_number ?? "")) set(row, "PO number", p.po_number!);
    set(row, "Clerk of works", clerkOf(p));
    // email lists someone changed on the dashboard replace what's in the diary; otherwise only empty cells are filled
    const pending = listsPending(p), changed = !!pending;
    set(row, "Send reports to", emails(p.report_to), changed);
    set(row, "CC on reports", emails(p.report_cc), changed);
    // only the project's own invoice contact: a company-wide one can belong to a different office or job
    const ic = contacts.find((c) => c.project_id === p.id);
    if (ic || pending?.invoice) { set(row, "Send invoice to", emails(ic?.to_emails), !!pending?.invoice); set(row, "CC on invoice", emails(ic?.cc_emails), !!pending?.invoice); }
    if (changed) copied.push(p.id);
  };
  const copied: string[] = [];

  const byJob = new Map(rows.filter((x) => x.v["Job no."]).map((x) => [x.v["Job no."], x]));
  for (const p of projects) {
    const row = p.number ? byJob.get(String(p.number)) : undefined;
    if (row) { fill(row, p); continue; }
    if (!RUNNING.includes(p.stage)) continue;
    const name = p.display_name.replace(/\s+\d{4}$/, "");
    if (rows.some((x) => x.v.Project && key(x.v.Project) === key(name))) continue; // already there, typed by hand
    // which company group: where this client's other jobs are; else a company heading that looks like the client's name
    const client = String((p.clients as { name?: string } | null)?.name ?? "");
    const theirs = rows.filter((x) => x.v["Job no."] && projects.find((q) => String(q.number) === x.v["Job no."])?.client_id === p.client_id && p.client_id);
    const counts = new Map<string, number>(); for (const x of theirs) counts.set(x.company, (counts.get(x.company) ?? 0) + 1);
    const ck = key(client).slice(0, 6);
    const group = [...counts.keys()].find((c) => /office to check/i.test(c)) ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      ?? (ck.length >= 3 ? rows.find((x) => x.v.Company && key(x.v.Company).startsWith(ck))?.v.Company : undefined);
    const spare = (group && rows.find((x) => x.company === group && !x.v.Project)) ?? rows.find((x) => !x.company && !x.v.Project);
    if (!spare) continue;
    // a spare row under its company already belongs to it; a free row at the bottom starts a new company block
    if (!spare.company) set(spare, "Company", group ?? client.replace(/\s+(ltd|limited|llp|plc)\.?$/i, ""));
    set(spare, "Project", name);
    fill(spare, p);
  }
  if (!changes.length) return { changed: 0, note: "", copied };
  if (!write) return { changed: changes.length, note: changes.map((c) => `${c.ref}=${c.value}`).join("; "), copied: [] as string[] };

  const zip = await JSZip.loadAsync(raw);
  const p = await sheetPath(zip, SHEET);
  if (!p) throw new Error(`can't find the ${SHEET} sheet inside the file`);
  let xml = await zip.file(p)!.async("string");
  for (const c of changes) xml = setCell(xml, c.ref, c.value);
  zip.file(p, xml);
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const now = await g.json<{ headRevisionId: string }>(`files/${fileId}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  if (now.headRevisionId !== meta.headRevisionId) return { changed: 0, waiting: true, note: "The diary changed while preparing; will try again later" };
  await g.replaceContent(fileId, out, XLSX);
  const after = await g.json<{ md5Checksum: string }>(`files/${fileId}`, { fields: "md5Checksum", supportsAllDrives: "true" });
  if (after.md5Checksum !== createHash("md5").update(out).digest("hex")) throw new Error("The diary on Drive doesn't match what was saved");
  return { changed: changes.length, note: `Diary ${year}: ${changes.length} Projects cells updated`, copied };
}
