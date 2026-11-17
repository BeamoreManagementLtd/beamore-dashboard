import type { SupabaseClient } from "@supabase/supabase-js";
import type { TrackerItem } from "./docx.mjs";

export const isMonthly = (r: { folder_name?: string | null; file_name: string }) => /monthly|end of month/i.test(r.folder_name ?? "") || /monthly|end of month/i.test(r.file_name);

/** The last weekly diary (same job, building or M&E) of the month a monthly report covers: by its visit date, else when it arrived. */
export async function lastDiaryOfMonth(admin: SupabaseClient, rep: { id: string; project_id: string | null; kind: string; file_name: string; uploaded_at: string }) {
  if (!rep.project_id) return null;
  const month = monthCovered(rep.file_name, rep.uploaded_at);
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10);
  const { data } = await admin.from("reports").select("id,file_name,folder_name,drive_file_id,visit_date,uploaded_at")
    .eq("project_id", rep.project_id).eq("kind", rep.kind).neq("id", rep.id)
    .or(`and(visit_date.gte.${month}-01,visit_date.lte.${end}),and(visit_date.is.null,uploaded_at.gte.${month}-01,uploaded_at.lte.${end}T23:59:59Z)`)
    .limit(40);
  const weekly = (data ?? []).filter((r) => !isMonthly(r))
    .sort((a, b) => (b.visit_date ?? b.uploaded_at.slice(0, 10)).localeCompare(a.visit_date ?? a.uploaded_at.slice(0, 10)));
  return weekly[0] ? { ...weekly[0], month } : null;
}

/**
 * Monthly reports (Ronan, 17 Nov 2026): "make sure that the issues tracker from the end of the month matches the one in
 * the monthly report, i.e. the monthly reports have been brought up to date". The monthly report's tracker is compared
 * with the one in the last weekly diary of the month it covers.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The month a monthly report covers, as "YYYY-MM": from its name ("October 2026", "Oct 26", "301026"), else the month before it arrived (if it arrived in the first half of a month) or the month it arrived. */
export function monthCovered(fileName: string, uploadedAt: string): string {
  const n = fileName.toLowerCase();
  const up = new Date(uploadedAt);
  for (let k = 0; k < 12; k++) {
    // the year only when it stands on its own ("October 2026", "Oct 26"), not the start of a date ("October -291026")
    const m = new RegExp(`\\b${MONTHS[k].slice(0, 3)}(${MONTHS[k].slice(3)})?\\b[\\s.,-]*('?(20)?(\\d{2})(?!\\d))?`).exec(n);
    if (!m) continue;
    let y = m[4] ? 2000 + Number(m[4]) : up.getUTCFullYear();
    if (!m[4] && k > up.getUTCMonth()) y--; // "December" arriving in January
    return `${y}-${String(k + 1).padStart(2, "0")}`;
  }
  // a month-end date in the name, e.g. "301026" or "30.10.26"
  const d = /\b(2[5-9]|3[01])[.\-_ ]?(\d{2})[.\-_ ]?(\d{2})\b/.exec(n);
  if (d && Number(d[2]) >= 1 && Number(d[2]) <= 12) return `20${d[3]}-${d[2]}`;
  const back = up.getUTCDate() <= 15 ? new Date(Date.UTC(up.getUTCFullYear(), up.getUTCMonth() - 1, 1)) : up;
  return back.toISOString().slice(0, 7);
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
const alike = (a: string, b: string) => {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0; for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= 0.5;
};
const num = (s: string) => /\d+/.exec(s)?.[0] ?? s.trim().toLowerCase();

export type TrackerGap = { missing: string[]; behind: string[]; weeklyItems: number; monthlyItems: number; monthlyHasTracker: boolean };

/**
 * What in the last weekly diary's tracker isn't in the monthly report's: open items left out, and items closed (or
 * turned green) since. Items closed long ago may be left out of a monthly report (Smithdon's leaves out July's), so
 * only open ones count as missing.
 */
export function compareTrackers(monthly: TrackerItem[], weekly: TrackerItem[], monthlyText: string[] = []): TrackerGap {
  // an item written up in the report's text instead of a table (Ormiston's monthly) counts as there
  const inText = (item: string) => monthlyText.some((p) => p.length > 20 && alike(item, p));
  const real = (i: TrackerItem) => (i.item.match(/[a-z]{3,}/gi) ?? []).length >= 2 && !/^no (new )?(issues|items)\b/i.test(i.item);
  monthly = monthly.filter(real); weekly = weekly.filter(real);
  const out: TrackerGap = { missing: [], behind: [], weeklyItems: weekly.length, monthlyItems: monthly.length, monthlyHasTracker: monthly.length > 0 };
  const used = new Set<number>();
  for (const w of weekly) {
    const open = !w.closed && w.colour !== "green";
    // the same item: same number and much the same words, else the same words under another number
    let k = monthly.findIndex((m, i) => !used.has(i) && num(m.no) === num(w.no) && alike(m.item, w.item));
    if (k < 0) k = monthly.findIndex((m, i) => !used.has(i) && alike(m.item, w.item));
    if (k < 0) { if (open && !inText(w.item) && !out.missing.includes(w.no)) out.missing.push(w.no); continue; }
    used.add(k);
    const m = monthly[k];
    // only where the monthly's tracker says what's open and closed
    if (m.hasStatus && ((w.closed && !m.closed) || (w.colour === "green" && m.colour && m.colour !== "green"))) out.behind.push(w.no);
  }
  return out;
}

/** The point for the checker, in words, or null when the monthly report is up to date. */
export function trackerGapText(g: TrackerGap, weeklyName: string): string | null {
  const list = (a: string[]) => `${a.slice(0, 10).join(", ")}${a.length > 10 ? ` and ${a.length - 10} more` : ""}`;
  if (!g.weeklyItems) return null;
  if (!g.monthlyHasTracker && g.missing.length) return `Issues tracker: the monthly report's tracker is empty or missing, but the last diary of the month (${weeklyName}) has open item${g.missing.length === 1 ? "" : "s"} ${list(g.missing)}`;
  const bits = [
    g.missing.length ? `open item${g.missing.length === 1 ? "" : "s"} ${list(g.missing)} from the diary not in the monthly report` : "",
    g.behind.length ? `item${g.behind.length === 1 ? "" : "s"} ${list(g.behind)} closed in the diary but still open here` : "",
  ].filter(Boolean);
  return bits.length ? `Issues tracker not brought up to date with the last diary of the month (${weeklyName}): ${bits.join("; ")}` : null;
}
