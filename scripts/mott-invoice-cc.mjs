/**
 * Mott MacDonald invoice CCs (Ronan, 15 Nov 2026): the CC on each Mott project's invoices becomes the Mott MacDonald
 * people its reports go to (nobody from other companies); Manchester projects also always CC Louise French, other
 * offices don't; the Birmingham projects stay as they are. Accounts payable stays the "to". Finished projects and ones
 * with no report list yet are left alone. Office from the diary's Projects tab (Company), matched by Job no.
 * Saves like the dashboard's email-list editor: the project's own invoice contact, a log entry, and marked for the
 * diary's Projects tab.   node scripts/mott-invoice-cc.mjs "<Diary 2026.xlsx>" [--apply]
 */
import fs from "node:fs"; import { createClient } from "@supabase/supabase-js";
import { loadWorkbook } from "../src/lib/sync/load-workbook.mjs";
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const emails = (s) => [...new Set((String([s ?? ""].flat().join(";")).match(EMAIL) ?? []).map((e) => e.trim()))];
const LOUISE = "Louise.French@mottmac.com";

const wb = await loadWorkbook(fs.readFileSync(process.argv[2]));
const ws = wb.getWorksheet("Projects");
const v = (c) => { const x = c.value; return x && typeof x === "object" ? (x.richText ? x.richText.map((t) => t.text).join("") : x.result ?? x.text ?? "") : x ?? ""; };
const head = []; ws.getRow(1).eachCell((c, i) => (head[i] = String(v(c))));
const col = (n) => head.findIndex((h) => h === n);
const officeByJob = new Map(); let company = "";
for (let r = 2; r <= ws.rowCount; r++) {
  const c = String(v(ws.getCell(r, col("Company")))).trim(); if (c) company = c;
  const job = String(v(ws.getCell(r, col("Job no.")))).trim();
  if (job && /mott/i.test(company)) officeByJob.set(job, { office: company, status: String(v(ws.getCell(r, col("Status")))).trim() });
}
const { data: projects } = await db.from("projects").select("id,number,name,stage,client_id,report_to,report_cc,details,clients(name)");
const { data: ics } = await db.from("invoice_contacts").select("id,project_id,client_id,label,to_emails,cc_emails,notes");
let changed = 0;
for (const p of projects) {
  const o = officeByJob.get(String(p.number)); if (!o) continue;
  if (/birmingham/i.test(o.office) || /finished/i.test(o.status) || p.stage === "complete") continue;
  const own = ics.find((c) => c.project_id === p.id), inv = own ?? ics.find((c) => !c.project_id && c.client_id === p.client_id);
  const to = emails(inv?.to_emails);
  const reportMott = [];
  for (const e of [...emails(p.report_to), ...emails(p.report_cc)]) if (/@mottmac\.com$/i.test(e) && !reportMott.some((x) => x.toLowerCase() === e.toLowerCase())) reportMott.push(e);
  if (!reportMott.length) continue;
  const manchester = /manchester/i.test(o.office);
  let cc = reportMott.filter((e) => manchester || e.toLowerCase() !== LOUISE.toLowerCase());
  if (manchester && !cc.some((e) => e.toLowerCase() === LOUISE.toLowerCase())) cc = [LOUISE, ...cc];
  cc = cc.filter((e) => !to.some((t) => t.toLowerCase() === e.toLowerCase()));
  const now = emails(inv?.cc_emails);
  const same = now.length === cc.length && now.every((e) => cc.some((c) => c.toLowerCase() === e.toLowerCase()));
  if (same) continue;
  changed++;
  console.log(`${o.office} | ${p.name}\n   was: ${now.join(", ") || "-"}\n   now: ${cc.join(", ")}${to.length ? "" : "  (NO invoice 'to' on record)"}`);
  if (!APPLY) continue;
  const client = p.clients?.name ?? "";
  await db.from("invoice_contacts").delete().eq("project_id", p.id);
  await db.from("invoice_contacts").insert({ project_id: p.id, client_id: null, label: own?.label ?? `${client} - ${p.name}`, to_emails: to, cc_emails: cc, notes: own?.notes ?? inv?.notes ?? null });
  const was = (p.details ?? {})._lists_pending;
  await db.from("projects").update({ details: { ...(p.details ?? {}), _lists_pending: { at: new Date().toISOString(), report: !!was?.report, invoice: true } }, updated_at: new Date().toISOString() }).eq("id", p.id);
  await db.from("project_events").insert({ project_id: p.id, source: "team", kind: "Email lists", who: "Ronan (via Claude)", body: `Invoices CC set to the Mott MacDonald people on the report lists${manchester ? " plus Louise French (Manchester)" : ""}: was ${now.join(", ") || "nobody"}; now ${cc.join(", ")}` });
}
console.log(`\n${changed} project${changed === 1 ? "" : "s"} ${APPLY ? "changed" : "would change"}`);
