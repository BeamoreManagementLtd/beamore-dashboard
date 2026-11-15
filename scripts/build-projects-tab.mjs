// Builds the diary's "Projects" tab (Ronan, 15 Nov 2026) from its "Invoice emails", "Invoice POs" and "Report emails"
// tabs plus the dashboard (clerks, PO and project numbers, status). Those three tabs are read only and left as they are.
//   node scripts/build-projects-tab.mjs <diary.xlsx> <out.xlsx>     (prints a report of anything it couldn't place)
import fs from "node:fs";
import JSZip from "jszip";
import { createClient } from "@supabase/supabase-js";
import { loadWorkbook } from "../src/lib/sync/load-workbook.mjs";
import { cellStyle } from "../src/lib/portal/diary-cells.mjs";
import { addSheet } from "../src/lib/portal/xlsx-sheet.mjs";

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
  const proj = [...s.matchAll(/\b(SRP\s?\d{3,4}|[A-Z]{2}MS\d{4}|SOCM\d{4}|FS\d{4}|\d{9}(?:[-.]\d{3})?)\b/g)].map((m) => m[1].replace(/\s/g, ""));
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
  [/^east village/i, /^east village$/i], [/^harrow/i, /^harrow/i], [/^colliers/i, /^colliers$/i], [/^celador/i, /^celador$/i], [/^cobalt/i, /^cobalt$/i], [/^v12/i, /^v12$/i],
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
const { data: projects } = await db.from("projects").select("id,display_name,name,site,diary_aliases,stage,report_to,po_number,dfe_project_number,clerk_id,clerk_me_id");
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

// ---------------------------------------------------------------- 5. the tab
const uniq = (a) => [...new Map(a.filter((x) => x && /\d/.test(x)).map((x) => [x.replace(/\s/g, "").toUpperCase(), x])).values()];
const uniqText = (a) => [...new Set(a.filter(Boolean))];
const order = new Map(); spine.forEach((x) => { if (!order.has(x.group)) order.set(x.group, order.size); });
spine.sort((a, b) => order.get(a.group) - order.get(b.group));
const rows = [["Company", "Project", "Project number", "PO number", "Send invoice to", "CC on invoice", "Invoice notes", "Clerk of works", "Send reports to", "CC on reports", "Status"]];
for (const s of spine) {
  const inv = s.inv ?? s.invGeneral;
  const c = codes(inv?.notes);
  const invNotes = uniqText([inv?.notes, s.inv ? null : s.invGeneral ? `From "${s.invGeneral.label}"` : null, ...s.notes]).join(". ");
  rows.push([s.group, s.site, uniq([...s.proj, ...c.proj]).join(" / "), uniq([...s.po, ...c.po]).join(" / "), inv?.to ?? "", inv?.cc ?? "", invNotes, s.clerk, s.reportTo, s.reportCc, s.project ? STAGE[s.project.stage] ?? s.project.stage : ""]);
}
console.log(`${rows.length - 1} projects; ${matched} matched to the dashboard; ${spine.filter((s) => s.inv).length} with their own invoice contacts, ${spine.filter((s) => !s.inv && s.invGeneral).length} from a company-wide entry, ${spine.filter((s) => !s.inv && !s.invGeneral).length} with none`);
for (const l of report) console.log(" -", l);
console.log("no invoice contacts:", spine.filter((s) => !s.inv && !s.invGeneral).map((s) => `${s.group}: ${s.site}`).join(" | "));
fs.writeFileSync(dst.replace(/\.xlsx$/, ".json"), JSON.stringify(rows, null, 1));

if (dst.endsWith(".xlsx")) {
  const zip = await JSZip.loadAsync(raw);
  const cd = await zip.file("xl/worksheets/sheet17.xml").async("string"); // Contact details: its header and body styles
  await addSheet(zip, "Projects", rows, { styles: { head: cellStyle(cd, "A1").s, body: cellStyle(cd, "A2").s }, widths: [24, 30, 22, 22, 40, 50, 45, 26, 60, 40, 11], freeze: { cols: 2, rows: 1 } });
  const calc = /<(?:\w+:)?calcPr\b[^>]*\/>/.exec(await zip.file("xl/workbook.xml").async("string"));
  fs.writeFileSync(dst, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
  console.log("written", dst, calc ? "" : "(no calcPr)");
}
