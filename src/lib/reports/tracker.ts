import "server-only";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { projectMatcher } from "@/lib/project-match";
import { dateInName } from "./naming.mjs";
import { isMonthly } from "./monthly";
import { addWorkingDays, workingDaysBetween } from "./days";

/**
 * The report tracker (Ronan, 17 Nov 2026), in place of Anél's "Diary TRACKER" spreadsheet: for every live job, which
 * weeks should have a report, which have one (Word or PDF, sent or not) and which are missing, worked out from the files
 * in the job's report folders, the diary (actual days, else planned) and the job's reporting frequency. Nobody colours
 * anything in.
 */

const MAIN_FOLDERS = new Set(["0B5LaG4Rs3CgQd2VIeW5Ya3F3SnM", "0B5LaG4Rs3CgQaElqRFNsNWRQcUk"]); // Schools, Others (under Work)
export const REPORT_FOLDER = /^(m&e |mep )?(diar(ies|y)|diaires|reports?|monthly reports?|site diar(ies|y))\s*$/i;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

type Folder = { id: string; name: string; parents?: string[] };
export type DriveFile = { id: string; name: string; parents?: string[]; createdTime: string; mimeType?: string };
type Drive = { json: <T>(path: string, params: Record<string, string>) => Promise<T>; download?: (fileId: string) => Promise<ArrayBuffer> };

export const mondayOf = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const plus = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** Works out the job each report folder belongs to (the same way the report scan does), remembering folders it's looked up. */
export function folderPlacer(g: Drive, projects: { id: string; name: string; diary_aliases: string[] | null; drive_folder_id: string | null }[]) {
  const folders = new Map<string, Folder | null>();
  const folder = async (id?: string) => {
    if (!id) return null;
    if (!folders.has(id)) folders.set(id, await g.json<Folder>(`files/${id}`, { fields: "id,name,parents", supportsAllDrives: "true" }).catch(() => null));
    return folders.get(id) ?? null;
  };
  const match = projectMatcher(projects.map((p) => ({ id: p.id, name: p.name, diary_aliases: p.diary_aliases ?? [] })));
  const byFolder = new Map(projects.filter((p) => p.drive_folder_id).map((p) => [p.drive_folder_id as string, p.id]));
  return async (f: DriveFile) => {
    const rf = await folder(f.parents?.[0]);
    if (!rf || !REPORT_FOLDER.test(rf.name.trim())) return null;
    const inner = await folder(rf.parents?.[0]);
    if (!inner) return null;
    let outer: Folder | null = null;
    if (!MAIN_FOLDERS.has(inner.parents?.[0] ?? "")) {
      const o = await folder(inner.parents?.[0]);
      if (!o || !MAIN_FOLDERS.has(o.parents?.[0] ?? "")) return null;
      outer = o;
    }
    const phase = outer ? inner.name.replace(/^project\s*/i, "").trim() : "";
    const projectId = byFolder.get(inner.id) ?? match.fromReference(outer ? `${outer.name} ${phase}` : inner.name)
      ?? (outer ? match.fromReference(`${outer.name} ${inner.name}`) : null) ?? null;
    return { rf, pf: { id: inner.id, name: outer ? `${outer.name}\\${inner.name}` : inner.name }, projectId };
  };
}

/**
 * Chasing missing reports (Ronan, 17 Nov 2026): once a report is missing, the clerk gets one friendly email from Ronan's
 * Gmail listing what's missing (each missing report is only ever mentioned once). Only from the last three weeks, only
 * when chasing is switched on (report_settings.chase_missing). Each one is kept on "Emails to send" as a record.
 */
export async function chaseMissing(admin: SupabaseClient, today: string, h: Set<string>) {
  const { data: s } = await admin.from("report_settings").select("chase_missing,clerk_days").eq("id", 1).single();
  if (!s?.chase_missing) return 0;
  const tr = await buildTracker(admin, today, h, 4, s.clerk_days ?? 2);
  const { data: done } = await admin.from("email_outbox").select("ref").eq("kind", "report-missing");
  const already = new Set((done ?? []).map((d) => d.ref));
  const byClerk = new Map<string, { ref: string; text: string; projectId: string }[]>();
  for (const m of tr.missing) {
    const ref = `${m.r.key}:${m.week}`;
    if (already.has(ref) || !m.r.clerkId || m.week < plus(today, -21)) continue;
    const what = m.r.kind === "monthly" ? `the monthly report for ${m.r.name.replace(/ monthly$/, "")}` : `${m.r.name}, week of ${new Date(`${m.week}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" })}`;
    byClerk.set(m.r.clerkId, [...(byClerk.get(m.r.clerkId) ?? []), { ref, text: what, projectId: m.r.projectId }]);
  }
  const { queueEmail } = await import("@/lib/outbox");
  let sent = 0;
  for (const [clerkId, items] of byClerk) {
    const { data: c } = await admin.from("clerks").select("name,email,active").eq("id", clerkId).single();
    if (!c?.email || !c.active) continue;
    const one = items.length === 1;
    const body = [
      `Hi ${c.name.split(" ")[0]}`,
      `I can't see ${one ? "a report" : "these reports"} in the project folder${one ? "" : "s"} yet:\n${items.map((i) => `- ${i.text}`).join("\n")}`,
      `Could you upload ${one ? "it" : "them"} when you get a chance? If ${one ? "it's" : "they're"} already somewhere else, or there wasn't a visit that week, just let me know and I'll update our records.`,
      `Many thanks\n\nRonan O'Boyle\nBeamore Management Ltd`,
    ].join("\n\n");
    const subject = one ? `Report not uploaded yet: ${items[0].text}` : `${items.length} reports not uploaded yet`;
    // nothing is sent automatically from Ronan's address (Ronan, 25 Nov 2026): it waits on "Emails to send" for a person to check and send
    for (const i of items) await queueEmail(admin, { kind: "report-missing", to: c.email, subject, body, clerkId, projectId: i.projectId, ref: i.ref, status: "waiting", note: "Check and send (automatic sending is off)" });
    sent++;
  }
  return sent;
}

/** Records report files (Word or PDF) that have landed in report folders. Returns how many were new. */
export async function recordReportFiles(admin: SupabaseClient, g: Drive, files: DriveFile[]) {
  if (!files.length) return 0;
  const { data: projects } = await admin.from("projects").select("id,name,diary_aliases,drive_folder_id");
  const place = folderPlacer(g, projects ?? []);
  const ids = files.map((f) => f.id);
  const known = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) for (const r of (await admin.from("report_files").select("drive_file_id").in("drive_file_id", ids.slice(i, i + 200))).data ?? []) known.add(r.drive_file_id);
  // a checked Word report's visit date, for files with no date in their name
  const visit = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) for (const r of (await admin.from("reports").select("drive_file_id,visit_date").in("drive_file_id", ids.slice(i, i + 200)).not("visit_date", "is", null)).data ?? []) visit.set(r.drive_file_id, r.visit_date);
  const rows = [];
  for (const f of files) {
    if (known.has(f.id) || f.name.startsWith("~$")) continue;
    const at = await place(f).catch(() => null);
    if (!at) continue;
    const type = /\.pdf$/i.test(f.name) || f.mimeType === "application/pdf" ? "pdf" : /\.doc$/i.test(f.name) ? "doc" : f.mimeType === DOCX || /\.docx$/i.test(f.name) ? "docx" : null;
    if (!type) continue;
    const named = dateInName(f.name);
    const created = f.createdTime.slice(0, 10);
    // a date in the name that's plausible (not in the future, not months before it arrived), else the checked visit
    // date, else two working days before it arrived (reports usually come in a day or two after the visit)
    const reportDate = named && named <= created && named >= plus(created, -45) ? named : visit.get(f.id) ?? plus(created, -2);
    rows.push({
      drive_file_id: f.id, name: f.name, file_type: type, folder_id: at.rf.id, folder_name: at.rf.name.trim(),
      project_folder_id: at.pf.id, project_folder_name: at.pf.name, project_id: at.projectId,
      kind: /m&e|mep/i.test(at.rf.name) || /\bm&e\b|\bmep\b|^\s*me\s?\d/i.test(f.name) ? "me" : "building", // "ME03- CoW Site Diary - Yeovil"
      monthly: isMonthly({ folder_name: at.rf.name, file_name: f.name }), created_time: f.createdTime, report_date: reportDate, week: mondayOf(reportDate),
    });
  }
  await readInside(admin, g, rows);
  for (let i = 0; i < rows.length; i += 200) await admin.from("report_files").upsert(rows.slice(i, i + 200));
  return rows.length;
}

type FileRow = { drive_file_id: string; name: string; file_type: string; folder_id: string; project_id: string | null; kind: string; monthly: boolean; created_time: string; report_date: string; week: string };
const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
/** "Site Visit Date: 12/10/2026", "Date of visit 6th October 2026"... as written in the report itself. */
export function visitDateInText(t: string) {
  const m = /(?:visit|inspection)\s*(?:date|on)?\s*(?:of\s*visit)?\s*:?\s*(?:[a-z]+day,?\s*)?(\d{1,2})(?:st|nd|rd|th)?[\s\/.\-]+(\d{1,2}|[a-z]{3,9})[\s\/.\-,]+(\d{2,4})/i.exec(t)
    ?? /date\s*of\s*visit\s*:?\s*(?:[a-z]+day,?\s*)?(\d{1,2})(?:st|nd|rd|th)?[\s\/.\-]+(\d{1,2}|[a-z]{3,9})[\s\/.\-,]+(\d{2,4})/i.exec(t);
  if (!m) return null;
  const mo = /^\d+$/.test(m[2]) ? m[2].padStart(2, "0") : MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mo || +mo > 12 || +m[1] < 1 || +m[1] > 31) return null;
  const iso = `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${mo}-${m[1].padStart(2, "0")}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}
const fileBase = (n: string) => n.replace(/\.(docx?|pdf)$/i, "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * What the report itself says (Ronan, 18 Nov 2026: Mark Hanson's Polam Hall reports have no date in their names, so
 * they were put in the wrong weeks and showed as missing; M&E reports kept in the building folder showed the M&E week
 * as missing): a Word report's visit date, and whether it was written by the job's M&E clerk rather than its building
 * clerk. A PDF follows its Word file of the same name. Changes the rows given.
 */
export async function readInside(admin: SupabaseClient, g: Drive, rows: FileRow[]) {
  if (!g.download || !rows.length) return 0;
  const pids = [...new Set(rows.map((r) => r.project_id).filter(Boolean))] as string[];
  const { data: ps } = pids.length ? await admin.from("projects").select("id,clerk_id,clerk_me_id").in("id", pids) : { data: [] };
  const cids = [...new Set((ps ?? []).flatMap((p) => [p.clerk_id, p.clerk_me_id]).filter(Boolean))] as string[];
  const { data: cs } = cids.length ? await admin.from("clerks").select("id,name").in("id", cids) : { data: [] };
  const surname = (id: string | null) => ((cs ?? []).find((c) => c.id === id)?.name ?? "").trim().split(/\s+/).at(-1)?.toLowerCase() ?? "";
  let changed = 0;
  const words = new Map<string, { date: string | null; kind: string | null }>();
  for (const r of rows.filter((x) => x.file_type === "docx" && !x.monthly)) {
    let text = "";
    try {
      const z = await JSZip.loadAsync(Buffer.from(await g.download(r.drive_file_id)));
      text = ((await z.file("word/document.xml")?.async("string")) ?? "").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").slice(0, 8000);
    } catch { continue; }
    const created = r.created_time.slice(0, 10);
    // only when the name has no usable date: clerks often copy last week's report and leave the old visit date inside
    // ("45- Burnside Secondary - W.C 28.9.26" still says 7 Sep), so a date in the name wins
    const named = dateInName(r.name);
    const d = named && named <= created && named >= plus(created, -45) ? null : visitDateInText(text);
    const date = d && d <= plus(created, 1) && d >= plus(created, -21) ? d : null; // an old copied date is ignored
    const p = (ps ?? []).find((x) => x.id === r.project_id);
    let kind: string | null = null;
    if (p?.clerk_me_id && p.clerk_id && p.clerk_me_id !== p.clerk_id) {
      const head = text.slice(0, 3000).toLowerCase(), me = surname(p.clerk_me_id), b = surname(p.clerk_id);
      // M&E only when it says so as well (Alan Wilcox's Bramhall diaries name him, the M&E clerk, but are building reports)
      const says = /m\s*&\s*e|\bmep\b|mechanical/.test(head);
      if (me && b && me !== b) kind = head.includes(me) && !head.includes(b) && says ? "me" : head.includes(b) && !head.includes(me) && !says ? "building" : null;
    }
    words.set(`${r.folder_id}|${fileBase(r.name)}`, { date, kind });
    if (date && date !== r.report_date) { r.report_date = date; r.week = mondayOf(date); changed++; }
    if (kind && kind !== r.kind) { r.kind = kind; changed++; }
  }
  // PDFs: their Word file's date and kind
  for (const r of rows.filter((x) => x.file_type === "pdf" && !x.monthly)) {
    // only a Word file whose date was just read from inside it: a date held from before may be a guess
    const w = words.get(`${r.folder_id}|${fileBase(r.name)}`);
    const pdfNamed = dateInName(r.name), pdfCreated = r.created_time.slice(0, 10);
    const ownDate = !!pdfNamed && pdfNamed <= pdfCreated && pdfNamed >= plus(pdfCreated, -45);
    if (!ownDate && w?.date && w.date !== r.report_date) { r.report_date = w.date; r.week = mondayOf(w.date); changed++; }
    if (w?.kind && w.kind !== r.kind) { r.kind = w.kind; changed++; }
  }
  return changed;
}

/** Missing reports before this week (a Monday) are no longer counted or chased. */
export const MISSING_FROM = "2026-11-02";
export type Cell = { state: "sent" | "in" | "missing" | "due" | "none" | "hol" | "hold"; files: { id: string; name: string }[]; overdue?: number; dueOn?: string; label?: string };
export type TrackerRow = { key: string; projectId: string; name: string; kind: "building" | "me" | "monthly"; clerk: string | null; clerkId: string | null; elsewhere: string | null; frequency: string | null; cells: Cell[] };

/** The grid: live jobs by week, last `weeks` weeks to this one. */
export async function buildTracker(db: SupabaseClient, today: string, h: Set<string>, weeks = 8, clerkDays = 2) {
  const thisWeek = mondayOf(today);
  const cols = Array.from({ length: weeks }, (_, k) => plus(thisWeek, -7 * (weeks - 1 - k)));
  const from = cols[0], to = plus(thisWeek, 6);
  const [{ data: projects }, { data: clerks }] = await Promise.all([
    db.from("projects").select("id,name,display_name,stage,reporting_frequency,clerk_id,clerk_me_id,reports_elsewhere,details").in("stage", ["live", "won_preparing", "on_hold"]),
    db.from("clerks").select("id,name"),
  ]);
  // every file since a little before the first week, a page at a time (a select stops at 1,000 rows)
  type F = { drive_file_id: string; name: string; file_type: string; project_id: string | null; kind: string; monthly: boolean; week: string; report_date: string; created_time: string; folder_id: string };
  const files: F[] = [];
  for (let page = 0; ; page++) {
    const { data } = await db.from("report_files").select("drive_file_id,name,file_type,project_id,kind,monthly,week,report_date,created_time,folder_id")
      .not("project_id", "is", null).gte("created_time", plus(from, -100)).order("drive_file_id").range(page * 1000, page * 1000 + 999);
    files.push(...((data ?? []) as F[]));
    if (!data || data.length < 1000) break;
  }
  const ps = projects ?? [];
  const pids = ps.map((p) => p.id);
  // diary visits in the period, building and M&E, both sides (chunked: a select stops at 1,000 rows)
  const visits: { project_id: string; kind: string; side: string; visit_date: string; clerk_id: string | null }[] = [];
  for (let i = 0; i < pids.length; i += 20) {
    const { data } = await db.from("diary_visits").select("project_id,kind,side,visit_date,clerk_id").in("project_id", pids.slice(i, i + 20)).gte("visit_date", from).lte("visit_date", to).limit(5000);
    visits.push(...(data ?? []));
  }
  const { data: absences } = await db.from("absences").select("clerk_id,date_from,date_to,status").neq("status", "cancelled").lte("date_from", to).gte("date_to", from);
  const clerkName = new Map((clerks ?? []).map((c) => [c.id, c.name as string]));
  // which months the diary has actual (charged) days for; others use the planned days
  const chargedMonths = new Set(visits.filter((v) => v.side === "charged").map((v) => v.visit_date.slice(0, 7)));
  const useVisit = (v: { side: string; visit_date: string }) => (chargedMonths.has(v.visit_date.slice(0, 7)) ? v.side === "charged" : v.side === "planned");
  const fl = files ?? [];
  // a Word report counts as sent once its PDF (same name) is in the same folder
  const base = (n: string) => n.replace(/\.(docx?|pdf)$/i, "").toLowerCase().replace(/\s*\(\d+\)\s*$/, "").replace(/(\s+copy)+$/, "").replace(/[^a-z0-9]/g, "");
  const pdfs = new Set(fl.filter((f) => f.file_type === "pdf").map((f) => `${f.folder_id}|${base(f.name)}`));
  const away = (clerkId: string | null, week: string) => {
    if (!clerkId) return false;
    const days = [0, 1, 2, 3, 4].map((k) => plus(week, k)).filter((d) => !h.has(d));
    return days.length > 0 && days.every((d) => (absences ?? []).some((a) => a.clerk_id === clerkId && a.date_from <= d && a.date_to >= d));
  };
  const rows: TrackerRow[] = [];
  for (const p of ps) {
    const name = p.display_name ?? p.name;
    for (const kind of ["building", "me"] as const) {
      const clerkId = (kind === "me" ? p.clerk_me_id : p.clerk_id) as string | null;
      const mine = fl.filter((f) => f.project_id === p.id && f.kind === kind && !f.monthly);
      const v = visits.filter((x) => x.project_id === p.id && x.kind === kind && useVisit(x));
      const recent = mine.some((f) => f.created_time >= plus(from, -60));
      // a row when there's a clerk for it and reports or visits to go on (a building clerk with a weekly frequency counts)
      if (!clerkId && !recent && !v.length) continue;
      if (!recent && !v.length && !(kind === "building" && p.reporting_frequency && p.stage === "live")) continue;
      // M&E written up in the building report ("plus M&E" in Anél's tracker: Yeovil, Highams Park, Castle Hill...): only
      // a job that's had its own M&E report lately is expected to have one
      if (kind === "me" && !mine.some((f) => f.created_time >= plus(from, -60))) continue;
      // weeks no report is needed (Ronan, 24 Nov 2026): before the job's reports start (Airbus starts next week), or marked
      // "not needed" on the tracker (a break on site: Greenfield)
      // ...or after they stop (snagging only from then on: Holy Trinity)
      const det = (p.details ?? {}) as { reports_from?: string; reports_until?: string; no_report_weeks?: string[] };
      const notNeeded = (w: string) => (!!det.reports_from && plus(w, 6) < det.reports_from) || (!!det.reports_until && w > det.reports_until) || (det.no_report_weeks ?? []).includes(w);
      // fortnightly jobs: a week with nothing in is only missing when the week before had nothing either (Star Radcliffe)
      const fortnightly = /fortnight/i.test(p.reporting_frequency ?? "");
      const cells: Cell[] = cols.map((w) => {
        const inWeek = mine.filter((f) => f.week === w);
        const got = inWeek.map((f) => ({ id: f.drive_file_id as string, name: f.name as string }));
        if (inWeek.length) {
          const sent = inWeek.some((f) => f.file_type === "pdf" || pdfs.has(`${f.folder_id}|${base(f.name)}`));
          return { state: sent ? "sent" : "in", files: got };
        }
        // building reports kept elsewhere (FieldView): M&E reports for the same job may still be in Drive (Framwellgate)
        if (p.reports_elsewhere && kind === "building") return { state: "none", files: [], label: p.reports_elsewhere };
        if (p.stage === "on_hold") return { state: "hold", files: [] };
        if (notNeeded(w)) return { state: "none", files: [], label: "not needed" };
        if (fortnightly && mine.some((f) => f.week === plus(w, -7))) return { state: "none", files: [] };
        const weekVisits = v.filter((x) => x.visit_date >= w && x.visit_date <= plus(w, 6)).map((x) => x.visit_date).sort();
        // the diary for that month says nothing about this job: fall back on its reporting frequency (weekly only)
        const monthHasDiary = visits.some((x) => x.project_id === p.id && useVisit(x) && x.visit_date.slice(0, 7) === w.slice(0, 7));
        const byFrequency = !monthHasDiary && kind === "building" && /weekly|fortnight/i.test(p.reporting_frequency ?? "") && p.stage === "live";
        if (!weekVisits.length && !byFrequency) return { state: "none", files: [] };
        if (away(clerkId, w)) return { state: "hol", files: [] };
        const last = weekVisits.at(-1) ?? plus(w, 4);
        const dueOn = addWorkingDays(last, clerkDays, h);
        if (today <= dueOn) return { state: "due", files: [], dueOn };
        return { state: "missing", files: [], dueOn, overdue: workingDaysBetween(dueOn, today, h) };
      });
      // a job that's only just started: nothing missing before its first report or visit
      const firstSeen = [...mine.map((f) => f.week as string), ...v.map((x) => mondayOf(x.visit_date))].sort()[0];
      if (firstSeen) cols.forEach((w, k) => { if (w < firstSeen && cells[k].state === "missing") cells[k] = { state: "none", files: [] }; });
      else cells.forEach((c, k) => { if (c.state === "missing") cells[k] = { state: "none", files: [] }; });
      rows.push({ key: `${p.id}:${kind}`, projectId: p.id, name: kind === "me" ? `${name} M&E` : name, kind, clerk: clerkId ? clerkName.get(clerkId) ?? null : null, clerkId, elsewhere: kind === "building" ? p.reports_elsewhere ?? null : null, frequency: p.reporting_frequency ?? null, cells });
    }
    // monthly reports: a job that's had one in the last few months is expected to send one for each month, within the
    // first week of the next; shown in the week it came in (or was due)
    const monthlies = fl.filter((f) => f.project_id === p.id && f.monthly);
    // a job that sends monthly reports: one in at least two of the three months before this one
    const monthsWith = new Set(monthlies.map((f) => f.created_time.slice(0, 7)));
    const back = [1, 2, 3].map((m) => { const d = new Date(`${thisWeek}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString().slice(0, 7); });
    const regular = back.filter((m) => monthsWith.has(m)).length >= 2;
    if (monthlies.length && p.stage === "live" && !p.reports_elsewhere) {
      const cells: Cell[] = cols.map(() => ({ state: "none", files: [] }));
      for (const f of monthlies) { const k = cols.indexOf(mondayOf(f.created_time.slice(0, 10))); if (k >= 0) cells[k] = { state: "sent", files: [...cells[k].files, { id: f.drive_file_id, name: f.name }], label: "Monthly" }; }
      for (let m = 1; m <= 2; m++) {
        const d = new Date(`${thisWeek}T00:00:00Z`); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - m + 1);
        const next = d.toISOString().slice(0, 10); // 1st of the month after the one reported on
        const dueOn = addWorkingDays(plus(next, -1), 5, h);
        const got = monthlies.some((f) => f.created_time.slice(0, 10) >= plus(next, -10) && f.created_time.slice(0, 10) <= plus(next, 30));
        const k = cols.indexOf(mondayOf(dueOn));
        if (got || k < 0 || cells[k].files.length || !regular) continue;
        cells[k] = today > dueOn ? { state: "missing", files: [], dueOn, overdue: workingDaysBetween(dueOn, today, h), label: "Monthly" } : { state: "due", files: [], dueOn, label: "Monthly" };
      }
      rows.push({ key: `${p.id}:monthly`, projectId: p.id, name: `${name} monthly`, kind: "monthly", clerk: p.clerk_id ? clerkName.get(p.clerk_id) ?? null : null, clerkId: p.clerk_id, elsewhere: null, frequency: "Monthly", cells });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  // reports missing from before the week of 2 November 2026 are written off (Ronan, 18 Nov 2026: "remove them all...
  // anything that's missing from the 2nd of November onwards, keep that"): shown blank, not missing, and never chased
  rows.forEach((r) => r.cells.forEach((c, k) => { if (c.state === "missing" && cols[k] < MISSING_FROM) r.cells[k] = { state: "none", files: [], label: "Written off" }; }));
  const missing =rows.flatMap((r) => r.cells.map((c, k) => ({ r, c, week: cols[k] })).filter((x) => x.c.state === "missing"))
    .sort((a, b) => (b.c.overdue ?? 0) - (a.c.overdue ?? 0));
  const noFrequency = ps.filter((p) => p.stage === "live" && !p.reporting_frequency && !p.reports_elsewhere).map((p) => ({ id: p.id, name: p.display_name ?? p.name }));
  return { cols, rows, missing, noFrequency };
}
