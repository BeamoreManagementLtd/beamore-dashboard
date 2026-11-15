// Builds the diary's "Projects" tab (Ronan, 15 Nov 2026) from its "Invoice emails", "Invoice POs" and "Report emails"
// tabs plus the dashboard (clerks, PO and project numbers, status). Those three tabs are read only and left as they are.
//   node scripts/build-projects-tab.mjs <diary.xlsx> <out.xlsx>     (prints a report of anything it couldn't place)
import fs from "node:fs";
import JSZip from "jszip";
import { createClient } from "@supabase/supabase-js";
import { loadWorkbook } from "../src/lib/sync/load-workbook.mjs";
import { cellStyle } from "../src/lib/portal/diary-cells.mjs";
import { addSheet, solidStyles, fontOf, sheetPath } from "../src/lib/portal/xlsx-sheet.mjs";

for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const [src, dst] = process.argv.slice(2);
const raw = fs.readFileSync(src);
const wb = await loadWorkbook(raw);

const val = (c) => { const v = c.value; if (v == null) return ""; if (typeof v === "object" && !(v instanceof Date)) return String(v.richText ? v.richText.map((t) => t.text).join("") : v.text ?? v.result ?? ""); return String(v); };
const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const key = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/\b(the|school|academy|primary|college|temps?|junior|jnr|road|st|saint)\b/g, "").replace(/[^a-z0-9]/g, "");
const emailsOf = (s) => [...new Set((String(s ?? "").match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map((e) => e.replace(/^'+|'+$/g, "")))];
const emailText = (s) => emailsOf(s).join("; ");
const sheetRows = (name, cols) => { const ws = wb.getWorksheet(name); const out = []; for (let r = 2; r <= ws.rowCount; r++) { const row = Array.from({ length: cols }, (_, i) => tidy(val(ws.getCell(r, i + 1)))); if (row.some(Boolean)) out.push({ r, row }); } return out; };
const report = [];

// ---------------------------------------------------------------- 1. Report emails: one row per project (the spine)
const spine = [];
let group = "";
const reportRows = sheetRows("Report emails", 7);
for (const { r, row } of reportRows) {
  const [a, site, inspector, , , to, cc] = row;
  if (a) group = a.replace(/^\*$/, "") || group;
  if (!site && !to && inspector && spine.length) { spine.at(-1).clerk = `${spine.at(-1).clerk}, ${inspector}`; continue; } // second clerk on the job above
  spine.push({ group, site, clerk: inspector, reportTo: emailText(to), reportCc: emailText(cc), po: [], proj: [], inv: null, invGeneral: null, notes: [], from: [`Report emails row ${r}`] });
}
// rows where the email list was pasted over the site name: name them from the Invoice POs tab's order
const poRows = sheetRows("Invoice POs", 9);
const poSites = []; group = "";
for (const { r, row } of poRows) { if (row[0]) group = row[0].replace(/^\*$/, "") || group; if (row[1]) poSites.push({ group, site: row[1], r }); }
spine.forEach((s, i) => {
  if (!/@/.test(s.site)) return;
  const before = spine[i - 1]?.site, after = spine[i + 1]?.site;
  const bi = poSites.findIndex((p) => key(p.site) === key(before)), ai = poSites.findIndex((p) => key(p.site) === key(after));
  const guess = bi >= 0 && ai === bi + 2 ? poSites[bi + 1].site : null;
  const taken = guess && spine.some((x) => x !== s && key(x.site) === key(guess));
  s.site = guess ? (taken ? `${guess} (2nd entry)` : guess) : "(name missing)";
  s.notes.push("Name filled in: the Report emails row had the email list where the site name goes");
  report.push(`Report emails row ${s.from[0].split(" ").at(-1)}: no site name, called it "${s.site}"`);
});

// the same project spelt differently in the tabs (checked by hand, 15 Nov 2026)
const SAME = {
  "mott macdonald - sheffield - st peters batley": "StPeters - Batley", "mott macdonald - newcastle": "Hempland", "mott macdonald - birmingham - blocwich": "Bloxwich",
  "gleeds - somerset": "Sommerset", "gleeds - sutton bonington": "Sutton Bonnington", "gleeds - bridge islington": "The Bridge Satellite School",
  "gleeds - burnsidepru": "Burnside Secondary", "mace - klb": "Katherine Lady Berkeley", "mace - bodmin": "Bosvena", "wsp - staidans": "St Aidans",
  "wsp - wisbech": "Thomas Clarkson - Wisbech", "atkinsrealis - regentsfarm": "Regent Farm", "arcadis - lincoln castle": "Castle View",
  "arcadis - stpatricks": "St. Patricks School", "anstey horne - dukes palace warf": "Dukes Palace Wharf", "horatio garden": "Horatios Garden",
};
const same = (label) => { const t = SAME[tidy(label).toLowerCase()]; return t ? spine.find((x) => x.site === t) ?? null : null; };
// an office's own entry that is also its default for its other projects (without the project's notes)
const ALSO_GENERAL = { "mott macdonald - newcastle": /newcastle/i };

// ---------------------------------------------------------------- 2. Invoice POs: PO and project numbers
const codes = (t) => {
  const s = String(t ?? "");
  const proj = [...s.matchAll(/\b(SRP\s?\d{3,4}|[A-Z]{2}MS\d{4}|SOCM\d{4}|FS\d{4}|FE\d{3,4}|PSBP\d{4}|\d{9}(?:[-.]\d{3})?)\b/g)].map((m) => m[1].replace(/\s/g, ""));
  const po = [...s.replace(/\b(SRP\s?\d{3,4}|[A-Z]{2}MS\d{4}|SOCM\d{4}|FS\d{4}|\d{9}(?:[-.]\d{3})?)\b/g, "").matchAll(/\b(MM\d{6,}|D-PO-E\d+|P\d{6}UK\d{3}|MLIMPD\d+|UK\d{6,}|\d{5,8})\b/g)].map((m) => m[1]);
  return { po, proj };
};
const findSite = (site, groupRe) => {
  const k = key(site);
  if (!k) return null;
  const pool = spine.filter((s) => !groupRe || groupRe.test(s.group));
  return pool.find((s) => key(s.site) === k)
    ?? (k.length >= 4 ? pool.filter((s) => key(s.site).length >= 4 && (key(s.site).startsWith(k) || k.startsWith(key(s.site)))) : []).at(0)
    ?? null;
};
const groupRegex = (g) => new RegExp(`^${g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
group = "";
for (const { r, row } of poRows) {
  if (row[0]) group = row[0].replace(/^\*$/, "") || group;
  const entries = [];
  if (row[1]) entries.push({ site: row[1], text: [row[2], row[3], row[4]], g: group });
  if (row[5] && /[a-z]{3}/i.test(row[5]) && !/^P\d+UK\d+$/.test(row[5])) entries.push({ site: row[5].replace(/^Gleeds - /, ""), text: [row[6], row[7], row[8]], g: null });
  else if (row[5]) entries.push({ site: row[1], text: [row[5]], g: group });
  for (const e of entries) {
    const s = same(e.site) ?? findSite(e.site, e.g ? groupRegex(e.g) : null) ?? findSite(e.site, null);
    const c = codes(e.text.join(" ")), other = e.text.slice(2).join(" ").trim();
    const code = /Code:\s*([\d.]+)/i.exec(e.text.join(" "))?.[1];
    if (!s) {
      spine.push({ group: e.g ?? group, site: e.site, clerk: "", reportTo: "", reportCc: "", po: c.po, proj: [...c.proj, ...(code ? [code] : [])], inv: null, invGeneral: null, notes: other ? [other] : [], from: [`Invoice POs row ${r}`] });
      report.push(`Invoice POs row ${r}: "${e.site}" isn't in Report emails, added as its own row`);
      continue;
    }
    s.po.push(...c.po); s.proj.push(...c.proj, ...(code ? [code] : []));
    if (other && !/@/.test(other)) s.notes.push(other);
    if (/ATTN/i.test(e.text.join(" "))) s.notes.push(e.text.find((t) => /ATTN/i.test(t)));
    s.from.push(`Invoice POs row ${r}`);
  }
}

// ---------------------------------------------------------------- 3. Invoice emails: who the invoice goes to
// the company names in Invoice emails → the company groups used in the other two tabs
const COMPANY = [
  [/^mott ?macdonald|^motts?\b/i, /^motts/i], [/^elbourn/i, /^elbourn/i], [/^atkins ?realis/i, /^atkins ?realis/i], [/^cumming/i, /^cummings?/i],
  [/^westmede/i, /^gleeds$/i], [/^space apartments|^anstey/i, /^anstey/i], [/^hcc/i, /^odpl/i], [/^pfp igloo/i, /^turner/i], [/^wt partnership/i, /^wt partnership/i],
  [/^siemens/i, /^siemens/i], [/^springstead/i, /^tmd/i], [/^honeywell/i, /^francesca/i], [/^archway bc/i, /^archwaybc/i], [/^archway investments/i, /^archway$/i],
  [/^blackheath/i, /^blackheath/i], [/^gleeds/i, /^gleeds$/i], [/^mace/i, /^mace$/i], [/^wsp/i, /^wsp$/i], [/^arcadis/i, /^arcadis$/i], [/^gpf ?lewis/i, /^gpflewis$/i],
  [/^barratt/i, /^barratt$/i], [/^east village/i, /^east village$/i], [/^harrow/i, /^harrow/i], [/^colliers/i, /^colliers$/i], [/^celador/i, /^celador$/i], [/^cobalt/i, /^cobalt$/i], [/^v12/i, /^v12$/i],
  [/^rps/i, /^rps$/i], [/^russ/i, /^russ$/i], [/^nrp/i, /^nrp$/i],
];
const REGIONS = [["london", /cambridge/i], ["cambridge", /cambridge/i], ["bristol", /bristol/i], ["manchester", /manchester/i], ["sheffield", /sheffield/i], ["leeds", /leeds/i], ["newcastle", /newcastle/i], ["birmingham", /birmingham/i]];
const extraNotes = [];
for (const { r, row } of sheetRows("Invoice emails", 4)) {
  const [label, to, cc, comments] = row;
  if (!label) continue;
  if (/single pdf|singel pdf/i.test(label)) { extraNotes.push([/^mace$/i, "One invoice per PDF only (Mace won't accept several in one file)"]); continue; }
  if (/statement every month/i.test(label)) { extraNotes.push([/^mace$/i, `Mace statement every month to ${emailText(to)}`]); continue; }
  if (!emailsOf(to).length && !emailsOf(cc).length && /tbc/i.test(to)) { const t = findSite(label.split(/ - /).at(-1), /^gleeds$/i); if (t) t.notes.push("Invoice contacts: tbc"); continue; }
  if (!emailsOf(to).length && !emailsOf(cc).length) { if (!/^motts manchester$/i.test(label)) report.push(`Invoice emails row ${r}: "${label}" has no email address, left out`); continue; }
  const parts = label.split(/\s*[-–]\s+|\s+[-–]\s*|\s*-\s*(?=[A-Z])/).map((p) => p.trim()).filter(Boolean);
  const groupRe = COMPANY.find(([re]) => re.test(parts[0]))?.[1] ?? groupRegex(parts[0]);
  const inv = { to: emailText(to), cc: emailText(cc), notes: comments, label, r };
  const isGeneral = /general/i.test(label) || parts.length === 1 || /^\(.*\)$/.test(parts.at(-1));
  let s = same(label);
  const alsoRe = ALSO_GENERAL[tidy(label).toLowerCase()];
  if (alsoRe) for (const t of spine.filter((x) => /^motts/i.test(x.group) && alsoRe.test(x.group))) if (!t.invGeneral) t.invGeneral = { ...inv, notes: "" };
  if (!s && !isGeneral) for (const p of [...parts.slice(1).reverse(), label]) { s = findSite(p.replace(/\(.*?\)/g, ""), groupRe) ?? findSite(p.replace(/^.*\((.*)\).*$/, "$1"), groupRe); if (s) break; }
  if (s) {
    if (s.inv) report.push(`Invoice emails row ${r}: "${label}" also matches ${s.site} (already has row ${s.inv.r}), kept the later one`);
    s.inv = inv; s.from.push(`Invoice emails row ${r}`);
    continue;
  }
  const regions = REGIONS.filter(([w]) => new RegExp(`\\b${w}\\b`, "i").test(label)).map(([, re]) => re);
  const targets = spine.filter((x) => groupRe.test(x.group) && (!regions.length || regions.some((re) => re.test(x.group))));
  if (isGeneral && targets.length) { for (const t of targets) if (!t.invGeneral) t.invGeneral = inv; continue; }
  // no project for it in the other tabs: its own row, so nothing is lost
  spine.push({ group: parts[0], site: parts.slice(1).join(" - ") || "(all projects)", clerk: "", reportTo: "", reportCc: "", po: [], proj: [], inv, invGeneral: null, notes: [], from: [`Invoice emails row ${r}`] });
  report.push(`Invoice emails row ${r}: "${label}" didn't match a project in the other tabs, added as its own row`);
}
for (const x of spine) {
  if (!/^motts/i.test(x.group) || !x.inv) continue;
  const office = REGIONS.find(([w]) => new RegExp(`\\b${w}\\b`, "i").test(x.inv.label));
  const g = office && spine.find((y) => /^motts/i.test(y.group) && office[1].test(y.group))?.group;
  if (g && g !== x.group) { report.push(`${x.site}: under ${x.group} in Report emails, but its invoice entry says ${g}; put under ${g}`); x.group = g; }
}
for (const [re, note] of extraNotes) for (const s of spine) if (re.test(s.group)) s.notes.push(note);

// ---------------------------------------------------------------- 4. the dashboard: clerks' full names, numbers, status
const { data: projects } = await db.from("projects").select("id,number,client_id,display_name,name,site,diary_aliases,stage,report_to,po_number,dfe_project_number,clerk_id,clerk_me_id");
const { data: clerks } = await db.from("clerks").select("id,name");
const clerkName = new Map(clerks.map((c) => [c.id, c.name]));
const STAGE = { live: "Live", complete: "Finished", won_arranging: "Starting", won_preparing: "Starting", on_hold: "On hold", lost: "Lost", enquiry: "Quote", sent: "Quote" };
const sameEmails = (a, b) => { const x = new Set(emailsOf(a).map((e) => e.toLowerCase())), y = new Set(emailsOf(b).map((e) => e.toLowerCase())); if (!x.size || !y.size) return 0; let n = 0; for (const e of x) if (y.has(e)) n++; return n / Math.max(x.size, y.size); };
const byFirst = new Map(); for (const c of clerks) { const f = key(c.name.split(" ")[0]); byFirst.set(f, byFirst.has(f) ? null : c.name); }
for (const s of spine) s.clerk = s.clerk.split(/\s*(?:,|&| and )\s*/).map((n) => (/^[A-Za-z]+$/.test(n.trim()) && byFirst.get(key(n)) ? byFirst.get(key(n)) : n.trim())).filter(Boolean).join(", ");
let matched = 0;
for (const s of spine) {
  const byName = projects.filter((p) => [p.display_name, p.name, p.site, ...(p.diary_aliases ?? [])].some((n) => n && key(n) && key(n) === key(s.site)));
  const byMail = s.reportTo ? projects.map((p) => [p, sameEmails(p.report_to, s.reportTo)]).filter(([, x]) => x >= 0.8).sort((a, b) => b[1] - a[1]).map(([p]) => p) : [];
  // a name alone only counts when the dashboard has no report list for that project, or this row has none to compare
  const nameOnly = byName.length === 1 && (!s.reportTo || !byName[0].report_to) ? byName[0] : null;
  const p = byName.find((x) => byMail.includes(x)) ?? nameOnly ?? byMail[0] ?? null;
  if (!p) continue;
  matched++;
  s.project = p;
  if (p.po_number) s.po.push(p.po_number);
  if (p.dfe_project_number) s.proj.push(p.dfe_project_number);
  const names = p.clerk_id && p.clerk_id === p.clerk_me_id ? [`${clerkName.get(p.clerk_id)} (building and M&E)`] : [p.clerk_id && clerkName.get(p.clerk_id), p.clerk_me_id && `${clerkName.get(p.clerk_me_id)} (M&E)`].filter(Boolean);
  if (names.length) s.clerk = names.join(", ");
}

// ---------------------------------------------------------------- 4b. running jobs in the dashboard that the old tabs never had
const { data: clients } = await db.from("clients").select("id,name");
const { data: invContacts } = await db.from("invoice_contacts").select("project_id,to_emails,cc_emails,notes,label").not("project_id", "is", null);
const used = new Set(spine.map((s) => s.project?.id).filter(Boolean));
const RUNNING = ["live", "won_arranging", "won_preparing", "on_hold"];
// dashboard job number -> the same job's row in the old tabs, named differently (checked by hand, 15 Nov 2026)
const DASH_SAME = { 1005: "Castle View", 1018: "Burnside Secondary", 1012: "Greenfields Academy", 1027: "Cornwall College", 1206: "Thomas Clarkson - Wisbech", 1339: "Sutton Bonnington" };
for (const p of projects.filter((x) => RUNNING.includes(x.stage) && !used.has(x.id))) {
  const client = clients.find((c) => c.id === p.client_id)?.name ?? "";
  const re = COMPANY.find(([r]) => r.test(client))?.[1];
  // already in the tab under its diary name (that row had no running dashboard job): that row is this job
  const names = [p.name, p.display_name, p.site, ...(p.diary_aliases ?? [])].filter(Boolean).map((n) => n.replace(/\s+\d{4}$/, ""));
  const row = (DASH_SAME[p.number] && spine.find((x) => x.site === DASH_SAME[p.number]))
    ?? names.map((n) => findSite(n, re ?? null) ?? (re ? null : findSite(n, null))).find((x) => x && (!x.project || !RUNNING.includes(x.project.stage)));
  if (row) {
    row.project = p; used.add(p.id);
    if (p.po_number) row.po.push(p.po_number);
    if (p.dfe_project_number) row.proj.push(p.dfe_project_number);
    const cn = [p.clerk_id && clerkName.get(p.clerk_id), p.clerk_me_id && p.clerk_me_id !== p.clerk_id && `${clerkName.get(p.clerk_me_id)} (M&E)`].filter(Boolean);
    if (cn.length) row.clerk = cn.join(", ");
    if (!row.reportTo && p.report_to) { row.reportTo = emailText(p.report_to); row.reportCc = emailText(p.report_cc); }
    report.push(`Dashboard job ${p.number} ${p.display_name} = the tab's ${row.group}: ${row.site}`);
    continue;
  }
  const group = re && /motts/.test(String(re)) ? "Motts (office to check)" : (re && spine.find((x) => re.test(x.group))?.group) || client.replace(/\s+(ltd|limited|llp|plc)\.?$/i, "") || "(no client)";
  const ic = invContacts.find((x) => x.project_id === p.id);
  const names2 = [p.clerk_id && clerkName.get(p.clerk_id), p.clerk_me_id && p.clerk_me_id !== p.clerk_id && `${clerkName.get(p.clerk_me_id)} (M&E)`].filter(Boolean);
  spine.push({ group, site: p.display_name.replace(/\s+\d{4}$/, ""), clerk: names2.join(", "), reportTo: emailText(p.report_to), reportCc: emailText(p.report_cc), po: p.po_number ? [p.po_number] : [], proj: p.dfe_project_number ? [p.dfe_project_number] : [],
    inv: ic ? { to: emailText([ic.to_emails].flat().join(";")), cc: emailText([ic.cc_emails].flat().join(";")), notes: ic.notes ?? "", label: ic.label } : null, invGeneral: null, notes: [], project: p, from: ["dashboard"] });
  report.push(`From the dashboard (not in the old tabs): ${group}: ${p.display_name}`);
}

// ---------------------------------------------------------------- 4c. what the email search found (FOUND=file1.json,file2.json)
const OFFICES = { "cambridge & london": "Motts Cambridge & London", london: "Motts Cambridge & London", cambridge: "Motts Cambridge & London", bristol: "Motts Bristol", manchester: "Motts Manchester", leeds: "Motts Leeds/sheffield", sheffield: "Motts Leeds/sheffield", "leeds/sheffield": "Motts Leeds/sheffield", newcastle: "Motts Newcastle", birmingham: "Motts Birmingham" };
let fromEmail = 0;
for (const f of (process.env.FOUND ?? "").split(",").filter(Boolean)) {
  for (const x of JSON.parse(fs.readFileSync(f, "utf8"))) {
    const s = spine.find((y) => y.group === x.company && y.site === x.project);
    if (!s) { report.push(`Email search: no row for ${x.company}: ${x.project}`); continue; }
    const firstSentence = (t) => String(t ?? "").split(/(?<=\.)\s/)[0].slice(0, 180);
    if (x.confidence === "low") { if (x.notes) s.notes.push(`From emails, to check: ${firstSentence(x.notes)}`); continue; }
    const list = (a) => emailText([a].flat().filter(Boolean).join(";"));
    let used = false;
    if (x.override) { s.notes = s.notes.filter((n) => !/^Invoice contacts: tbc/.test(n)); s.inv = { to: list(x.invoice_to), cc: list(x.invoice_cc), notes: x.notes ?? "", label: "Ronan" }; if (x.clerk && !s.clerk) s.clerk = x.clerk; fromEmail++; continue; }
    if (!(s.inv ?? s.invGeneral) && list(x.invoice_to)) { s.inv = { to: list(x.invoice_to), cc: list(x.invoice_cc), notes: "", label: "emails" }; used = true; }
    if (!s.reportTo && list(x.report_to)) { s.reportTo = list(x.report_to); s.reportCc = list(x.report_cc); used = true; }
    if (!s.clerk && x.clerk) { s.clerk = x.clerk; used = true; }
    if (x.po_number && !s.po.length) { s.po.push(String(x.po_number)); used = true; }
    if (x.project_number) {
      const c = codes(x.project_number).proj, add = (c.length ? c : [String(x.project_number).split("(")[0].trim()]).filter((v) => !s.proj.some((p) => p.replace(/\s/g, "").toUpperCase() === v.replace(/\s/g, "").toUpperCase()));
      if (add.length) { s.proj.push(...add); used = true; }
    }
    const office = x.mott_office && Object.entries(OFFICES).find(([k]) => String(x.mott_office).toLowerCase().includes(k))?.[1];
    if (office && /office to check/.test(s.group)) { s.group = office; used = true; }
    if (x.client && s.group === "(no client)") {
      // Andy Howard's address is the one on the Elbourn invoice row
      const name = /andrew\.howard5@/i.test(x.client) ? "Elbourn" : String(x.client).split(/[;(,]/)[0].trim().replace(/\s+(ltd|limited|llp|plc)\.?$/i, "");
      const re = COMPANY.find(([r]) => r.test(name))?.[1];
      s.group = (re && spine.find((y) => re.test(y.group))?.group) || name; used = true;
    }
    if (used) { s.notes.push(x.notes ? `From emails: ${firstSentence(x.notes)}` : "Some details found in emails"); fromEmail++; }
  }
}

// ---------------------------------------------------------------- 4d. Xero: PO and job numbers written on our invoices
// (the dashboard's copy of the invoices links each one to its project; XERO=file has the PO numbers from the lines)
const xinv = [];
for (let f = 0; ; f += 1000) { const { data } = await db.from("invoices").select("number,project_id,reference,issued").not("project_id", "is", null).order("issued", { ascending: false }).range(f, f + 999); xinv.push(...data); if (data.length < 1000) break; }
const xlines = process.env.XERO ? new Map(JSON.parse(fs.readFileSync(process.env.XERO, "utf8")).map((x) => [x.invoice_number, x])) : new Map();
let fromXero = 0;
for (const s of spine) {
  if (!s.project) continue;
  const mine = xinv.filter((i) => i.project_id === s.project.id); // newest first
  const before = s.po.length + s.proj.length;
  for (const i of mine) s.proj.push(...codes(i.reference).proj);
  if (!s.po.length) { const latest = mine.map((i) => xlines.get(i.number)).find((x) => x?.po?.length); if (latest) s.po.push(...latest.po.map(String)); }
  if (!s.proj.length) { const latest = mine.map((i) => xlines.get(i.number)).find((x) => x?.codes?.length); if (latest) s.proj.push(...latest.codes.map(String).filter((c) => !/PC Invoice/i.test(c))); }
  if (s.po.length + s.proj.length > before) fromXero++;
}
report.push(`Xero invoices filled numbers for ${fromXero} projects`);

// ---------------------------------------------------------------- 5. the tab
// the DfE's own numbers for the job (SRP1234, FS0433, FE016, PSBP2226)
const DFE = /^(SRP|FS|FE|PSBP)\s?\d{3,4}$/i;
const SPARE = 3; // empty rows left under each company for new projects
const uniq = (a) => [...new Map(a.filter((x) => x && /\d/.test(x)).map((x) => [x.replace(/\s/g, "").toUpperCase(), x])).values()];
const uniqText = (a) => [...new Set(a.filter(Boolean))];
const order = new Map(); spine.forEach((x) => { if (!order.has(x.group)) order.set(x.group, order.size); });
spine.sort((a, b) => order.get(a.group) - order.get(b.group));
const rows = [["Company", "Project", "Project number", "DfE project number", "PO number", "Send invoice to", "CC on invoice", "Invoice notes", "Clerk of works", "Send reports to", "CC on reports", "Status", "Job no."]];
spine.forEach((s, i) => {
  const inv = s.inv ?? s.invGeneral;
  const c = codes(inv?.notes);
  const invNotes = uniqText([inv?.notes, s.inv ? null : s.invGeneral ? `From "${s.invGeneral.label}"` : null, ...s.notes]).join(". ");
  rows.push([s.group, s.site, uniq([...s.proj, ...c.proj].filter((x) => !DFE.test(x))).join(" / "), uniq([...s.proj, ...c.proj].filter((x) => DFE.test(x)).map((x) => x.replace(/\s/g, "").toUpperCase())).join(" / "),uniq([...s.po, ...c.po]).join(" / "), inv?.to ?? "", inv?.cc ?? "", invNotes, s.clerk, s.reportTo, s.reportCc, s.project ? STAGE[s.project.stage] ?? s.project.stage : "", s.project?.number ? String(s.project.number) : ""]);
  if (spine[i + 1]?.group !== s.group) for (let k = 0; k < SPARE; k++) rows.push([s.group, ...Array(12).fill("")]);
});
console.log(`${spine.length} projects; ${matched} matched to the dashboard; ${spine.filter((s) => s.inv).length} with their own invoice contacts, ${spine.filter((s) => !s.inv && s.invGeneral).length} from a company-wide entry, ${spine.filter((s) => !s.inv && !s.invGeneral).length} with none; ${fromEmail} helped by the email search`);
for (const l of report) console.log(" -", l);
const NEW_CLIENTS = 40; // empty rows at the bottom for new clients
for (let k = 0; k < NEW_CLIENTS; k++) rows.push(Array(13).fill(""));
fs.writeFileSync(dst.replace(/\.xlsx$/, ".json"), JSON.stringify(rows, null, 1));

if (dst.endsWith(".xlsx")) {
  const zip = await JSZip.loadAsync(raw);
  const cd = await zip.file(await sheetPath(zip, "Contact details")).async("string");
  const headFont = await fontOf(zip, Number(cellStyle(cd, "A1").s)), bodyFont = await fontOf(zip, Number(cellStyle(cd, "A2").s));
  // the shading Judy and Anél use: a grey header, then white and light grey lines in turn
  const [head, white, grey] = await solidStyles(zip, [{ font: headFont, rgb: "FFBDBDBD" }, { font: bodyFont, rgb: "FFFFFFFF" }, { font: bodyFont, rgb: "FFF3F3F3" }]);
  await addSheet(zip, "Projects", rows, { styleOf: (i) => (i === 0 ? head : i % 2 ? white : grey), widths: [24, 30, 22, 16, 22, 40, 50, 45, 30, 60, 40, 11, 8], freeze: { cols: 2, rows: 1 }, replace: process.env.REPLACE === "1" });
  fs.writeFileSync(dst, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  console.log("written", dst);
}
