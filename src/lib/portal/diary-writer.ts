import "server-only";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import type ExcelJS from "exceljs";
import { driveClient } from "@/lib/google";
import { loadWorkbook } from "@/lib/sync/load-workbook.mjs";
import { matchSites } from "./read-document";
import { setCell, setNumberCell, cellStyle, greenVersion } from "./diary-cells.mjs";
import { companyLabel } from "./contact-sheet.mjs";

/**
 * Writes a clerk's invoice into the salmon (charged) side of Diary 2026.xlsx (Ronan, 15 Nov 2026). Same rules as the
 * old portal's diary writer:
 *  - only months from November 2026 (earlier months are protected), only that clerk's own block
 *  - site names must be the exact names already used (the Rates tab), matched from the invoice wording using that
 *    clerk's previous months; anything unsure is held for Ronan, never guessed
 *  - only empty salmon cells are written: a full day puts the site in the 1st and 2nd slots, a half day in one slot,
 *    three half-days fill all three; a 4th half-day goes in the nearest empty 3rd slot that month
 *  - only those cells (and the "recalculate on open" flag) change; every other part of the file is left exactly as
 *    it was, so formulas, formatting and the other tabs are untouched. Drive keeps the previous version
 *  - nothing is written while the diary was changed in the last 10 minutes (someone may have it open)
 *  - then that clerk's "Invoice received" box is turned green, using the same green the diary already uses
 */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FIRST_WRITABLE = "2026-11";
/** Diary file for a year ("2026" -> Drive id), from the diary sync. */
const diaryFile = (conn: { diary_files?: Record<string, string> | null; diary_file_id?: string | null }, year: string) =>
  conn.diary_files?.[year] ?? (year === "2026" ? conn.diary_file_id ?? null : null);
const QUIET_MS = 10 * 60 * 1000;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type Visit = { date: string; site: string; half_days: number };
type Outcome = { state: "written" | "needs_review" | "waiting" | "not_applicable"; note: string };

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
const colName = (n: number) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const cellVal = (c: ExcelJS.Cell) => {
  const v = (c.master ?? c).value as unknown;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string; formula?: string };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.text !== undefined) return o.text;
    if (o.formula !== undefined) return { formula: o.formula };
    return o.result ?? null;
  }
  return v;
};
const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim());
/** How this clerk usually words sites -> exact diary names. */
export async function resolveSites(admin: SupabaseClient, clerkId: string, wordings: string[]) {
  const since = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10);
  const [{ data: rates }, { data: mine }, { data: aliases }] = await Promise.all([
    admin.from("rates").select("site_as_typed"),
    admin.from("diary_visits").select("site_as_typed").eq("clerk_id", clerkId).eq("side", "charged").gte("visit_date", since),
    admin.from("site_aliases").select("clerk_id,wording,site_as_typed").or(`clerk_id.eq.${clerkId},clerk_id.is.null`),
  ]);
  const names = (rates ?? []).map((r) => r.site_as_typed as string);
  const exact = new Map(names.map((n) => [norm(n), n]));
  const count = new Map<string, number>();
  for (const v of mine ?? []) count.set(v.site_as_typed, (count.get(v.site_as_typed) ?? 0) + 1);
  const clerkSites = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).filter((n) => exact.has(norm(n))).map((n) => exact.get(norm(n))!).slice(0, 40);
  const alias = new Map<string, string>();
  for (const a of (aliases ?? []).sort((x, y) => Number(!!y.clerk_id) - Number(!!x.clerk_id))) if (!alias.has(norm(a.wording))) alias.set(norm(a.wording), a.site_as_typed);

  const out = new Map<string, string | null>(), learnt: [string, string][] = [];
  const ask: string[] = [];
  for (const w of wordings) {
    const k = norm(w);
    if (alias.has(k) && exact.has(norm(alias.get(k)!))) out.set(w, exact.get(norm(alias.get(k)!))!);
    else if (exact.has(k)) out.set(w, exact.get(k)!);
    else {
      // only one of the sites this clerk has charged to lately shares the wording's name: that's it (Keith Osorio,
      // 21 Nov 2026: "Gosford Hill School, Oxford" and "Amwell, Buntingford" were held back because the diary also has
      // Gosford(M&E) and Amwell(M&E) columns, though he has only ever charged to Gosford(Building) and Amwell)
      const words = w.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 3 && !/^(the|and|school|primary|academy|college|site|road|street|centre)$/.test(x));
      const squash = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
      const hits = clerkSites.filter((n) => words.some((x) => squash(n).includes(x)));
      if (hits.length === 1) { out.set(w, hits[0]); learnt.push([w, hits[0]]); }
      else ask.push(w);
    }
  }
  if (ask.length) {
    // other candidates: rates names sharing a word with the wording (keeps the list short and relevant)
    const words = new Set(ask.flatMap((w) => w.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !/^(the|and|school|primary|academy|site|ltd)$/.test(x))));
    const others = names.filter((n) => !clerkSites.includes(n) && n.toLowerCase().split(/[^a-z0-9]+/).some((x) => words.has(x))).slice(0, 80);
    const m = await matchSites(ask, clerkSites, others);
    for (const w of ask) {
      const hit = m.find((x) => x.wording === w);
      const name = hit?.certain && hit.site && exact.has(norm(hit.site)) ? exact.get(norm(hit.site))! : null;
      out.set(w, name);
      if (name) learnt.push([w, name]);
    }
  }
  return { map: out, learnt };
}

export async function writeInvoiceToDiary(admin: SupabaseClient, uploadId: string): Promise<Outcome> {
  const { data: u } = await admin.from("portal_uploads").select("id,receipt,clerk_id,sha256,ai_result,status,clerks(name)").eq("id", uploadId).single();
  const clerkName = (u?.clerks as unknown as { name: string } | null)?.name;
  if (!u || !u.clerk_id || !clerkName) return { state: "not_applicable", note: "No clerk for this invoice" };
  const done = await admin.from("portal_diary_cells").select("id", { count: "exact", head: true }).eq("upload_id", uploadId);
  if (done.count) return { state: "written", note: "Already in the diary" };
  let visits = (((u.ai_result as { visits?: Visit[] } | null)?.visits) ?? []).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v.date) && v.site?.trim() && v.half_days > 0);
  // set out by week instead of by date ("The Forum WC 2nd Nov 5 days @ £340", Damian Breen, 25 Nov 2026): that many
  // weekdays from the Monday of that week
  if (!visits.length) visits = weekVisits(u.ai_result as { lines?: { text: string }[]; period?: string | null } | null);
  if (!visits.length) return { state: "needs_review", note: "The invoice doesn't list the dates worked, so it can't go in the diary automatically" };
  const months = [...new Set(visits.map((v) => v.date.slice(0, 7)))];
  if (months.some((m) => m < FIRST_WRITABLE)) return { state: "needs_review", note: `Work in ${months.filter((m) => m < FIRST_WRITABLE).join(", ")}: months before November 2026 aren't written automatically` };
  const year = months[0].slice(0, 4);
  if (months.some((m) => !m.startsWith(year))) return { state: "needs_review", note: "This invoice covers two different years; please enter it by hand" };

  // ---- exact diary names for each site wording
  const wordings = [...new Set(visits.map((v) => v.site.trim()))];
  const { map, learnt } = await resolveSites(admin, u.clerk_id, wordings);
  const unsure = wordings.filter((w) => !map.get(w));
  if (unsure.length) return { state: "needs_review", note: `Couldn't be sure which diary site: ${unsure.map((w) => `"${w}"`).join(", ")}` };

  // ---- the days must add up to what the invoice charges (Ronan, 25 Nov 2026: Andrew Marris's "Wales High School
  // November x 5 @ 310.00" went in as five half days; a visit charged at the day rate is a whole day, the site visit
  // and the report). The reading of the dates is checked against the money at the diary's rates and the invoice's
  // day count; a visit read as a half day becomes a whole day when that's what the invoice adds up to.
  const settled = await settleDays(admin, u.ai_result as Ai, visits, (w) => map.get(w.trim())!);
  if (!settled.visits) return { state: "needs_review", note: settled.note ?? "The days don't add up" };
  visits = settled.visits!;
  const rateNote = settled.note ?? "";

  // ---- one list of slot values per day
  const perDay = new Map<string, string[]>();
  for (const v of visits) {
    const list = perDay.get(v.date) ?? [];
    for (let i = 0; i < Math.min(v.half_days, 4); i++) list.push(map.get(v.site.trim())!);
    perDay.set(v.date, list);
  }
  const tooMany = [...perDay.entries()].filter(([, l]) => l.length > 8);
  if (tooMany.length) return { state: "needs_review", note: `More than four days' work claimed on ${tooMany.map(([d]) => d).join(", ")}` };

  // ---- the diary itself
  const g = await driveClient(admin);
  const fileId = diaryFile(g.connection, year);
  if (!fileId) return { state: "waiting", note: `Waiting for Diary ${year}.xlsx to be created in the Diary folder` };
  const meta = await g.json<{ modifiedTime: string; headRevisionId: string; md5Checksum: string }>(`files/${fileId}`, { fields: "modifiedTime,headRevisionId,md5Checksum", supportsAllDrives: "true" });
  if (Date.now() - Date.parse(meta.modifiedTime) < QUIET_MS) return { state: "waiting", note: "The diary was changed in the last 10 minutes; will try again shortly" };
  const raw = Buffer.from(await g.download(fileId));
  const wb = await loadWorkbook(raw);

  const changes: { sheet: string; ref: string; value: string; work: string; diary: string }[] = [];
  const markers: { sheet: string; ref: string }[] = [];
  const expenses = ((((u.ai_result as { expenses?: { text: string; amount_gbp: number | null }[] } | null)?.expenses) ?? [])
    .filter((e) => e && e.text && Number(e.amount_gbp) > 0));
  const extras: { sheet: string; ref: string; text?: string; amount?: number }[] = [];
  let expenseNote = "";
  for (const month of months) {
    const sheet = MONTHS[Number(month.slice(5)) - 1];
    const ws = wb.getWorksheet(sheet);
    if (!ws) return { state: "needs_review", note: `No ${sheet} sheet in the diary` };
    const starts: number[] = [];
    ws.getRow(2).eachCell((c, col) => { if (/^1st location$/i.test(String(cellVal(c) ?? "").trim())) starts.push(col); });
    const s = starts.at(-1);
    if (!s || !/^2nd location$/i.test(String(cellVal(ws.getCell(2, s + 2)) ?? "").trim()) || !/^3rd location$/i.test(String(cellVal(ws.getCell(2, s + 4)) ?? "").trim()))
      return { state: "needs_review", note: `The ${sheet} sheet's layout isn't the usual one` };
    const nameCol = s - 2, dateCol = s - 1;
    // the clerk's block: rows whose (merged) name cell starts with their name
    const rows: number[] = [];
    for (let r = 3; r <= ws.rowCount; r++) {
      const v = cellVal(ws.getCell(r, nameCol));
      if (typeof v === "string" && norm(v.split("\n")[0]) === norm(clerkName)) rows.push(r);
    }
    if (!rows.length) return { state: "needs_review", note: `${clerkName} has no block in the ${sheet} diary` };
    const anchor = rows.find((r) => cellVal(ws.getCell(r, dateCol)) instanceof Date);
    if (!anchor) return { state: "needs_review", note: `${clerkName}'s ${sheet} block has no dates` };
    const a = cellVal(ws.getCell(anchor, dateCol)) as Date;
    const dateOf = (r: number) => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() + (r - anchor))).toISOString().slice(0, 10);
    const rowOf = new Map(rows.map((r) => [dateOf(r), r]));
    const slotCols = [s, s + 2, s + 4];
    const free = (r: number, i: number) => isBlank(cellVal(ws.getCell(r, slotCols[i])));
    const hasCost = (r: number, i: number) => { const v = cellVal(ws.getCell(r, slotCols[i] + 1)); return !!v && typeof v === "object" && "formula" in (v as object); };
    const taken = new Set<string>();
    const overflow: { date: string; value: string }[] = [];
    for (const [date, values] of [...perDay.entries()].filter(([d]) => d.startsWith(month)).sort()) {
      const r = rowOf.get(date);
      if (!r) return { state: "needs_review", note: `No row for ${date} in ${clerkName}'s ${sheet} block` };
      if (![0, 1, 2].every((i) => free(r, i))) return { state: "needs_review", note: `${date} already has entries on the charged side; left for you to check` };
      values.slice(0, 3).forEach((value, i) => {
        if (!hasCost(r, i)) throw new Error(`no cost formula next to ${colName(slotCols[i])}${r}`);
        changes.push({ sheet, ref: `${colName(slotCols[i])}${r}`, value, work: date, diary: date });
        taken.add(`${r}:${i}`);
      });
      for (const value of values.slice(3)) overflow.push({ date, value });
    }
    // more than three half-days on one date (several sites visited, each a day's charge): the rest go in the nearest
    // free slots that month, the way the office does it by hand (Andrew Marris and Tony Larkins in October)
    for (const o of overflow) {
      const cand = rows.filter((r) => dateOf(r).startsWith(month) && dateOf(r) !== o.date)
        .flatMap((r) => [0, 1, 2].filter((i) => free(r, i) && !taken.has(`${r}:${i}`) && hasCost(r, i)).slice(0, 1).map((i) => ({ r, i })))
        .sort((x, y) => Math.abs(Date.parse(dateOf(x.r)) - Date.parse(o.date)) - Math.abs(Date.parse(dateOf(y.r)) - Date.parse(o.date)) || x.r - y.r);
      if (!cand.length) return { state: "needs_review", note: `Nowhere free in the month for all the work on ${o.date}` };
      const { r, i } = cand[0];
      changes.push({ sheet, ref: `${colName(slotCols[i])}${r}`, value: o.value, work: o.date, diary: dateOf(r) });
      taken.add(`${r}:${i}`);
    }
    const label = rows.find((r) => /^invoice received$/i.test(String(cellVal(ws.getCell(r, s + 7)) ?? "").trim()));
    if (label) markers.push({ sheet, ref: `${colName(s + 7)}${label}` });
    // the invoice's expenses (hotels, mileage...) on the block's "Other costs" line, so the block's total matches the
    // invoice (Ronan, 15 Nov 2026); diaries from 2027 have that line under day 31
    if (expenses.length && month === months[months.length - 1]) {
      const oc = [1, 2, 3].map((k) => Math.max(...rows) + k).find((r) => /^other costs/i.test(String(cellVal(ws.getCell(r, s)) ?? "").trim()));
      const total = Math.round(expenses.reduce((n, e) => n + Number(e.amount_gbp), 0) * 100) / 100;
      if (!oc) expenseNote = `the invoice has £${total.toFixed(2)} of expenses (${expenses.map((e) => e.text).join(", ")}): this diary has no Other costs line, so add them by hand`;
      // the amount goes in the Cost cell next to the label, what it's for in the merged box after it (Ronan, 17 Nov 2026);
      // older diaries had the amount in the 3rd slot's cost cell (s + 5)
      else if (!isBlank(cellVal(ws.getCell(oc, s + 2))) || !isBlank(cellVal(ws.getCell(oc, s + 1))) || !isBlank(cellVal(ws.getCell(oc, s + 5)))) expenseNote = `${clerkName}'s Other costs line already has something in it; the invoice's £${total.toFixed(2)} of expenses weren't added`;
      else {
        const merged = ws.getCell(oc, s + 3).isMerged; // the 2026 / 2027 diaries after the merge: amount next to the label
        extras.push({ sheet, ref: `${colName(s + 2)}${oc}`, text: expenses.map((e) => `${e.text} £${Number(e.amount_gbp).toFixed(2)}`).join("; ").slice(0, 250) });
        extras.push({ sheet, ref: `${colName(merged ? s + 1 : s + 5)}${oc}`, amount: total });
        expenseNote = `£${total.toFixed(2)} of expenses put on the Other costs line`;
      }
    }
  }

  // ---- patch only those cells in the original file
  const zip = await JSZip.loadAsync(raw);
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  const pathOf = (sheet: string) => {
    const rid = new RegExp(`<(?:\\w+:)?sheet\\b[^>]*name="${sheet}"[^>]*r:id="([^"]+)"`).exec(wbXml)?.[1] ?? new RegExp(`<(?:\\w+:)?sheet\\b[^>]*r:id="([^"]+)"[^>]*name="${sheet}"`).exec(wbXml)?.[1];
    const target = rid && new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] || rid && new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1];
    if (!target) throw new Error(`can't find the ${sheet} sheet inside the file`);
    return target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  };
  const styles = await zip.file("xl/styles.xml")?.async("string") ?? "";
  const markerNotes: string[] = [];
  for (const sheet of [...new Set(changes.map((c) => c.sheet))]) {
    const p = pathOf(sheet);
    let xml = await zip.file(p)!.async("string");
    for (const c of changes.filter((x) => x.sheet === sheet)) xml = setCell(xml, c.ref, c.value);
    for (const e of extras.filter((x) => x.sheet === sheet)) {
      try { xml = e.amount !== undefined ? setNumberCell(xml, e.ref, e.amount) : setCell(xml, e.ref, e.text ?? ""); }
      catch { expenseNote = "the expenses couldn't be put on the Other costs line; please add them by hand"; }
    }
    for (const m of markers.filter((x) => x.sheet === sheet)) {
      const st = cellStyle(xml, m.ref);
      const green = st ? greenVersion(styles, Number(st.s)) : null;
      if (st && green !== null && Number(st.s) !== green) xml = xml.replace(st.tag, st.tag.replace(/\bs="\d+"/, `s="${green}"`));
      else if (green === null) markerNotes.push(`colour ${clerkName}'s "Invoice received" box by hand (${sheet})`);
    }
    zip.file(p, xml);
  }
  const calc = /<(?:\w+:)?calcPr\b[^>]*\/>/.exec(wbXml);
  if (calc) zip.file("xl/workbook.xml", wbXml.replace(calc[0], calc[0].replace(/\s+(fullCalcOnLoad|forceFullCalc)="[^"]*"/g, "").replace(/\/>$/, ' fullCalcOnLoad="1"/>')));
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });

  // ---- last check that nobody saved the diary meanwhile, then save as a new version and confirm it arrived
  const now = await g.json<{ headRevisionId: string; modifiedTime: string }>(`files/${fileId}`, { fields: "headRevisionId,modifiedTime", supportsAllDrives: "true" });
  if (now.headRevisionId !== meta.headRevisionId) return { state: "waiting", note: "The diary changed while preparing; will try again shortly" };
  await g.replaceContent(fileId, out, XLSX);
  const after = await g.json<{ headRevisionId: string; md5Checksum: string; modifiedTime: string }>(`files/${fileId}`, { fields: "headRevisionId,md5Checksum,modifiedTime", supportsAllDrives: "true" });
  if (after.md5Checksum !== createHash("md5").update(out).digest("hex")) throw new Error("The diary on Drive doesn't match what was saved");

  await admin.from("portal_diary_cells").insert(changes.map((c) => ({ upload_id: uploadId, sheet: c.sheet, cell: c.ref, value: c.value, work_date: c.work, diary_date: c.diary, revision_after: after.headRevisionId })));
  for (const [wording, site] of learnt) await admin.from("site_aliases").upsert({ clerk_id: u.clerk_id, wording, site_as_typed: site, created_by: "AI" }, { onConflict: "clerk_id,wording" });
  const days = changes.length / 2;
  return { state: "written", note: `${changes.length} half-day${changes.length === 1 ? "" : "s"} (${days} day${days === 1 ? "" : "s"}) written to ${[...new Set(changes.map((c) => c.sheet))].join(", ")}${markerNotes.length ? `; ${markerNotes.join("; ")}` : "; Invoice received marked green"}${expenseNote ? `; ${expenseNote}` : ""}${rateNote ? `; ${rateNote}` : ""}` };
}

/** Every 15 minutes: invoices read by AI that are waiting to go into the diary (one at a time, so writes never overlap). */
export async function writePendingToDiary(admin: SupabaseClient) {
  const { data } = await admin.from("portal_uploads").select("id").eq("kind", "invoice").eq("diary_state", "waiting").neq("status", "deleted").order("received_at").limit(5);
  let written = 0;
  for (const r of data ?? []) {
    let o: Outcome;
    try { o = await writeInvoiceToDiary(admin, r.id); }
    catch (e) { o = { state: "needs_review", note: `Couldn't write to the diary: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` }; }
    await admin.from("portal_uploads").update({ diary_state: o.state, diary_note: o.note }).eq("id", r.id);
    if (o.state === "written") written++;
    if (o.state === "waiting") break; // diary busy: try the rest next time
  }
  return written;
}

// ---------------------------------------------------------------- holidays (Ronan, 15 Nov 2026)
/**
 * Puts a holiday into the diary the way the team does it by hand: "Holiday" (or Sick, etc.) in that clerk's Comments
 * cell on the salmon side, for each weekday of it. Same rules as the invoice writer: months from November 2026 only,
 * only that clerk's block, only empty Comments cells (a day that already has a comment is left and reported), not
 * while the diary was changed in the last 10 minutes, nothing else in the file touched, Drive keeps the old version.
 * The diary sync then ticks the holiday off as "in the diary".
 */
export async function writeHolidayToDiary(admin: SupabaseClient, absenceId: string): Promise<Outcome> {
  const { data: h } = await admin.from("absences").select("id,clerk_id,date_from,date_to,part_day,kind,status,synced_to_diary_at,clerks(name)").eq("id", absenceId).single();
  const clerkName = (h?.clerks as unknown as { name: string } | null)?.name;
  if (!h || !clerkName || h.status === "cancelled") return { state: "not_applicable", note: "No holiday to write" };
  if (h.synced_to_diary_at) return { state: "written", note: "Already in the diary" };
  const days: string[] = [];
  for (let t = Date.parse(`${h.date_from}T00:00:00Z`); t <= Date.parse(`${h.date_to}T00:00:00Z`); t += 864e5) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
  }
  if (!days.length) return { state: "not_applicable", note: "No weekdays in this holiday" };
  if (days.length > 31) return { state: "needs_review", note: "Longer than a month; please put it in the diary by hand" };
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  if (months.some((m) => m < FIRST_WRITABLE)) return { state: "needs_review", note: "Months before November 2026 aren't written automatically" };
  const year = months[0].slice(0, 4);
  if (months.some((m) => !m.startsWith(year))) return { state: "needs_review", note: "This holiday runs into the next year; please put it in both diaries by hand" };
  // words the diary sync reads back as a holiday (diary-parse.mjs), so it can tick this one off
  const kind = /holiday|annual leave|sick|day off/i.test(h.kind ?? "") ? h.kind : "Day off";
  const word = `${kind}${h.part_day ? ` (${h.part_day})` : ""}`;

  const g = await driveClient(admin);
  const fileId = diaryFile(g.connection, year);
  if (!fileId) return { state: "waiting", note: `Waiting for Diary ${year}.xlsx to be created in the Diary folder` };
  const meta = await g.json<{ modifiedTime: string; headRevisionId: string }>(`files/${fileId}`, { fields: "modifiedTime,headRevisionId", supportsAllDrives: "true" });
  if (Date.now() - Date.parse(meta.modifiedTime) < QUIET_MS) return { state: "waiting", note: "The diary was changed in the last 10 minutes; will try again shortly" };
  const raw = Buffer.from(await g.download(fileId));
  const wb = await loadWorkbook(raw);

  const changes: { sheet: string; ref: string }[] = [];
  const already: string[] = [], taken: string[] = [];
  for (const month of months) {
    const sheet = MONTHS[Number(month.slice(5)) - 1];
    const ws = wb.getWorksheet(sheet);
    if (!ws) return { state: "needs_review", note: `No ${sheet} sheet in the diary` };
    const starts: number[] = [];
    ws.getRow(2).eachCell((c, col) => { if (/^1st location$/i.test(String(cellVal(c) ?? "").trim())) starts.push(col); });
    const s = starts.at(-1);
    if (!s || !/^comments$/i.test(String(cellVal(ws.getCell(2, s + 6)) ?? "").trim())) return { state: "needs_review", note: `The ${sheet} sheet's layout isn't the usual one` };
    const nameCol = s - 2, dateCol = s - 1, commentCol = s + 6;
    const rows: number[] = [];
    for (let r = 3; r <= ws.rowCount; r++) {
      const v = cellVal(ws.getCell(r, nameCol));
      if (typeof v === "string" && norm(v.split("\n")[0]) === norm(clerkName)) rows.push(r);
    }
    if (!rows.length) return { state: "needs_review", note: `${clerkName} has no block in the ${sheet} diary` };
    const anchor = rows.find((r) => cellVal(ws.getCell(r, dateCol)) instanceof Date);
    if (!anchor) return { state: "needs_review", note: `${clerkName}'s ${sheet} block has no dates` };
    const a = cellVal(ws.getCell(anchor, dateCol)) as Date;
    const dateOf = (r: number) => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate() + (r - anchor))).toISOString().slice(0, 10);
    const rowOf = new Map(rows.map((r) => [dateOf(r), r]));
    for (const d of days.filter((x) => x.startsWith(month))) {
      const r = rowOf.get(d);
      if (!r) return { state: "needs_review", note: `No row for ${d} in ${clerkName}'s ${sheet} block` };
      const now = String(cellVal(ws.getCell(r, commentCol)) ?? "").trim();
      if (/holiday|annual leave|\ba\/l\b|on leave|sick|day off/i.test(now)) { already.push(d); continue; }
      if (now) { taken.push(d); continue; }
      changes.push({ sheet, ref: `${colName(commentCol)}${r}` });
    }
  }
  if (!changes.length) return taken.length ? { state: "needs_review", note: `Comments already written on ${taken.join(", ")}; please add the holiday by hand` } : { state: "written", note: "Already in the diary" };

  const zip = await JSZip.loadAsync(raw);
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  for (const sheet of [...new Set(changes.map((c) => c.sheet))]) {
    const rid = new RegExp(`<(?:\\w+:)?sheet\\b[^>]*name="${sheet}"[^>]*r:id="([^"]+)"`).exec(wbXml)?.[1] ?? new RegExp(`<(?:\\w+:)?sheet\\b[^>]*r:id="([^"]+)"[^>]*name="${sheet}"`).exec(wbXml)?.[1];
    const target = rid && (new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] || new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1]);
    if (!target) throw new Error(`can't find the ${sheet} sheet inside the file`);
    const p = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    let xml = await zip.file(p)!.async("string");
    for (const c of changes.filter((x) => x.sheet === sheet)) {
      try { xml = setCell(xml, c.ref, word); } catch { return { state: "needs_review", note: `Couldn't find the Comments cell ${c.ref} on ${sheet}; please add the holiday by hand` }; }
    }
    zip.file(p, xml);
  }
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const latest = await g.json<{ headRevisionId: string }>(`files/${fileId}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  if (latest.headRevisionId !== meta.headRevisionId) return { state: "waiting", note: "The diary changed while preparing; will try again shortly" };
  await g.replaceContent(fileId, out, XLSX);
  const after = await g.json<{ md5Checksum: string }>(`files/${fileId}`, { fields: "md5Checksum", supportsAllDrives: "true" });
  if (after.md5Checksum !== createHash("md5").update(out).digest("hex")) throw new Error("The diary on Drive doesn't match what was saved");
  return { state: "written", note: `"${word}" written for ${changes.length} day${changes.length === 1 ? "" : "s"}${taken.length ? `; ${taken.join(", ")} already had a comment, so add those by hand` : ""}` };
}

/** Every 15 minutes: holidays waiting to go into the diary (one at a time). */
export async function writePendingHolidays(admin: SupabaseClient) {
  const { data } = await admin.from("absences").select("id").eq("diary_state", "waiting").neq("status", "cancelled").order("date_from").limit(5);
  let written = 0;
  for (const r of data ?? []) {
    let o: Outcome;
    try { o = await writeHolidayToDiary(admin, r.id); }
    catch (e) { o = { state: "needs_review", note: `Couldn't write to the diary: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` }; }
    await admin.from("absences").update({ diary_state: o.state === "not_applicable" ? "needs_review" : o.state, diary_note: o.note }).eq("id", r.id);
    if (o.state === "written") written++;
    if (o.state === "waiting") break;
  }
  return written;
}

// ---------------------------------------------------------------- company names under clerks' names (Ronan, 15 Nov 2026)
// companyLabel (the company to show for a person) lives in contact-sheet.mjs so the Contact details tab uses the same rule
export { companyLabel };

/**
 * Puts each clerk's own company in brackets on a second line under their name, in both name columns of every month
 * from November 2026 ("Joe Bloggs" + "(Link Contracting Ltd)"). The first line, the person, is never changed. Companies
 * someone only works through (e.g. an agency) aren't shown. Same care as invoice writing: only those cells change.
 */
export async function labelDiaryCompanies(admin: SupabaseClient, { write = true } = {}) {
  const g0 = await driveClient(admin);
  const files: Record<string, string> = { ...(g0.connection.diary_files ?? {}) };
  if (!files["2026"] && g0.connection.diary_file_id) files["2026"] = g0.connection.diary_file_id;
  const results: { changed: number; note: string }[] = [];
  for (const year of Object.keys(files).sort()) results.push(await labelOneDiary(admin, files[year], year, { write }));
  return { changed: results.reduce((n, r) => n + r.changed, 0), note: results.map((r) => r.note).filter(Boolean).join("; ") };
}

async function labelOneDiary(admin: SupabaseClient, fileId: string, year: string, { write = true } = {}) {
  const { data: links } = await admin.from("clerk_companies").select("company_name,clerks(name)").eq("kind", "own").eq("status", "Enabled");
  const byPerson = new Map<string, string[]>();
  for (const l of links ?? []) {
    const n = (l.clerks as unknown as { name: string } | null)?.name;
    if (n) byPerson.set(norm(n), [...(byPerson.get(norm(n)) ?? []), l.company_name]);
  }
  const g = await driveClient(admin);
  const meta = await g.json<{ modifiedTime: string; headRevisionId: string }>(`files/${fileId}`, { fields: "modifiedTime,headRevisionId", supportsAllDrives: "true" });
  if (write && Date.now() - Date.parse(meta.modifiedTime) < QUIET_MS) return { changed: 0, note: `Diary ${year} changed in the last 10 minutes; try later` };
  const raw = Buffer.from(await g.download(fileId));
  const wb = await loadWorkbook(raw);
  const changes: { sheet: string; ref: string; value: string }[] = [];
  for (let m = year === FIRST_WRITABLE.slice(0, 4) ? Number(FIRST_WRITABLE.slice(5)) - 1 : 0; m < 12; m++) {
    const ws = wb.getWorksheet(MONTHS[m]);
    if (!ws) continue;
    const starts: number[] = [];
    ws.getRow(2).eachCell((c, col) => { if (/^1st location$/i.test(String(cellVal(c) ?? "").trim())) starts.push(col); });
    for (const s of starts) {
      for (let r = 3; r <= ws.rowCount; r++) {
        const c = ws.getCell(r, s - 2);
        if (c.isMerged && c.master.address !== c.address) continue; // only the top cell of each merged name block
        const v = cellVal(c);
        if (typeof v !== "string" || !v.trim()) continue;
        const person = v.split(/\r?\n/)[0].trim();
        const company = companyLabel(person, byPerson.get(norm(person)) ?? []);
        if (!company) continue;
        const want = `${person}\n(${company})`;
        if (v.trim() !== want) changes.push({ sheet: MONTHS[m], ref: c.address, value: want });
      }
    }
  }
  if (!changes.length || !write) return { changed: changes.length, note: changes.map((c) => `${c.sheet} ${c.ref}: ${c.value.replace("\n", " ")}`).join("; ") };

  const zip = await JSZip.loadAsync(raw);
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  for (const sheet of [...new Set(changes.map((c) => c.sheet))]) {
    const rid = new RegExp(String.raw`<(?:\w+:)?sheet\b[^>]*name="${sheet}"[^>]*r:id="([^"]+)"`).exec(wbXml)?.[1];
    const target = rid && (new RegExp(String.raw`<Relationship\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(String.raw`<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1]);
    if (!target) throw new Error(`can't find the ${sheet} sheet inside the file`);
    const p = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    let xml = await zip.file(p)!.async("string");
    for (const c of changes.filter((x) => x.sheet === sheet)) xml = setCell(xml, c.ref, c.value);
    zip.file(p, xml);
  }
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const now = await g.json<{ headRevisionId: string }>(`files/${fileId}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  if (now.headRevisionId !== meta.headRevisionId) return { changed: 0, note: "The diary changed while preparing; try later" };
  await g.replaceContent(fileId, out, XLSX);
  const after = await g.json<{ md5Checksum: string }>(`files/${fileId}`, { fields: "md5Checksum", supportsAllDrives: "true" });
  if (after.md5Checksum !== createHash("md5").update(out).digest("hex")) throw new Error("The diary on Drive doesn't match what was saved");
  await admin.from("portal_audit").insert({ actor: "dashboard", action: "diary-company-labels", detail: { changes } });
  return { changed: changes.length, note: `Diary ${year}: ${changes.length} name cells labelled` };
}

/** Visits from invoice lines set out by week: "The Forum WC 2nd Nov 5 days @ £340" -> Mon 2 to Fri 6 Nov at "The Forum". */
export function weekVisits(ai: { lines?: { text: string }[]; period?: string | null } | null): Visit[] {
  const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const year = Number((ai?.period ?? "").slice(0, 4)) || new Date().getUTCFullYear();
  const out: Visit[] = [];
  for (const l of ai?.lines ?? []) {
    const m = /^(.*?)\s*(?:w\/?c|week\s+commencing)\s*(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?\s*(\d{4})?\D+?(\d+(?:\.5)?)\s*days?\b/i.exec(l.text.trim());
    if (!m) continue;
    const mon = MON.indexOf(m[3].toLowerCase());
    if (mon < 0 || !m[1].trim()) continue;
    const start = new Date(Date.UTC(Number(m[4]) || year, mon, Number(m[2])));
    const days = Number(m[5]);
    if (!(days > 0 && days <= 7)) continue;
    // from that day, the next weekdays (whole days; a half day at the end)
    let left = days * 2;
    for (let d = new Date(start); left > 0 && d.getTime() - start.getTime() < 14 * 864e5; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const half = Math.min(2, left);
      out.push({ date: d.toISOString().slice(0, 10), site: m[1].replace(/[-–:,]\s*$/, "").trim(), half_days: half });
      left -= half;
    }
  }
  return out;
}

type Ai = { days?: number | null; net_gbp?: number | null; expenses?: { amount_gbp: number | null }[] | null } | null;

/**
 * Checks the dates read from an invoice against what it charges (Ronan, 25 Nov 2026). Two readings are tried: as read,
 * and every visit a whole day (a school visit plus its report is charged at the day rate). The one that costs what the
 * invoice charges at the diary's rates wins; failing that, the one with the invoice's number of days (the diary's rate
 * for a site then differs from the clerk's, which is said in the note). Neither: held for a person.
 */
export async function settleDays(admin: SupabaseClient, ai: Ai, visits: Visit[], siteOf: (wording: string) => string): Promise<{ visits?: Visit[]; note?: string }> {
  const readings = [visits, visits.map((v) => ({ ...v, half_days: 2 }))];
  const halves = (vs: Visit[]) => vs.reduce((n, v) => n + v.half_days, 0);
  const { data: rates } = await admin.from("rates").select("site_as_typed,pay").in("site_as_typed", [...new Set(visits.map((v) => siteOf(v.site)))]);
  const pay = new Map((rates ?? []).map((r) => [r.site_as_typed as string, Number(r.pay)]));
  const cost = (vs: Visit[]) => vs.every((v) => (pay.get(siteOf(v.site)) ?? 0) > 0) ? Math.round(vs.reduce((n, v) => n + v.half_days * pay.get(siteOf(v.site))! / 2, 0) * 100) / 100 : null;
  const expenses = (ai?.expenses ?? []).reduce((n, e) => n + (Number(e?.amount_gbp) || 0), 0);
  const work = ai?.net_gbp != null ? Math.round((Number(ai.net_gbp) - expenses) * 100) / 100 : null;
  if (work !== null) {
    const hit = readings.find((vs) => { const c = cost(vs); return c !== null && Math.abs(c - work) <= Math.max(1, work * 0.005); });
    if (hit) return { visits: hit };
  }
  const days = Number(ai?.days);
  if (days > 0) {
    const hit = readings.find((vs) => halves(vs) === Math.round(days * 2));
    if (hit) {
      const c = cost(hit);
      return { visits: hit, ...(work !== null && c !== null ? { note: `the diary's rates come to £${c} for these days but the invoice charges £${work}: check the rates` } : {}) };
    }
    return { note: `The dates on the invoice come to ${halves(visits) / 2} day${halves(visits) === 2 ? "" : "s"} but it charges ${days}; please put it in the diary by hand` };
  }
  return work === null ? { visits } : { note: `The dates on the invoice don't add up to the £${work} it charges at the diary's rates; please put it in the diary by hand` };
}

/** Takes an invoice back out of the diary: clears the cells written for it, if they still hold what was written. */
export async function undoInvoiceInDiary(admin: SupabaseClient, uploadId: string): Promise<string> {
  const { data: cells } = await admin.from("portal_diary_cells").select("id,sheet,cell,value,diary_date").eq("upload_id", uploadId);
  if (!cells?.length) return "nothing in the diary";
  const year = cells[0].diary_date.slice(0, 4);
  const g = await driveClient(admin);
  const fileId = diaryFile(g.connection, year);
  if (!fileId) throw new Error(`no Diary ${year}`);
  const meta = await g.json<{ modifiedTime: string; headRevisionId: string }>(`files/${fileId}`, { fields: "modifiedTime,headRevisionId", supportsAllDrives: "true" });
  if (Date.now() - Date.parse(meta.modifiedTime) < QUIET_MS) throw new Error("The diary was changed in the last 10 minutes; try again shortly");
  const raw = Buffer.from(await g.download(fileId));
  const wb = await loadWorkbook(raw);
  for (const c of cells) {
    const v = cellVal(wb.getWorksheet(c.sheet)!.getCell(c.cell));
    if (String(v ?? "") !== c.value) throw new Error(`${c.sheet} ${c.cell} now holds "${v}", not "${c.value}": left for you`);
  }
  const zip = await JSZip.loadAsync(raw);
  const wbXml = await zip.file("xl/workbook.xml")!.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")!.async("string");
  for (const sheet of [...new Set(cells.map((c) => c.sheet))]) {
    const rid = new RegExp(String.raw`<(?:\w+:)?sheet\b[^>]*name="${sheet}"[^>]*r:id="([^"]+)"`).exec(wbXml)?.[1] ?? new RegExp(String.raw`<(?:\w+:)?sheet\b[^>]*r:id="([^"]+)"[^>]*name="${sheet}"`).exec(wbXml)?.[1];
    const target = rid && new RegExp(String.raw`<Relationship\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] || rid && new RegExp(String.raw`<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1];
    if (!target) throw new Error(`can't find the ${sheet} sheet inside the file`);
    const p = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    let xml = await zip.file(p)!.async("string");
    for (const c of cells.filter((x) => x.sheet === sheet)) xml = setCell(xml, c.cell, "");
    zip.file(p, xml);
  }
  const calc = /<(?:\w+:)?calcPr\b[^>]*\/>/.exec(wbXml);
  if (calc) zip.file("xl/workbook.xml", wbXml.replace(calc[0], calc[0].replace(/\s+(fullCalcOnLoad|forceFullCalc)="[^"]*"/g, "").replace(/\/>$/, ' fullCalcOnLoad="1"/>')));
  const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const now = await g.json<{ headRevisionId: string }>(`files/${fileId}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  if (now.headRevisionId !== meta.headRevisionId) throw new Error("The diary changed while preparing; try again");
  await g.replaceContent(fileId, out, XLSX);
  const after = await g.json<{ md5Checksum: string }>(`files/${fileId}`, { fields: "md5Checksum", supportsAllDrives: "true" });
  if (after.md5Checksum !== createHash("md5").update(out).digest("hex")) throw new Error("The diary on Drive doesn't match what was saved");
  await admin.from("portal_diary_cells").delete().eq("upload_id", uploadId);
  return `${cells.length} cells cleared`;
}
