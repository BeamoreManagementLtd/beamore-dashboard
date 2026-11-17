/**
 * The visit date from a report's file name (Ronan, 17 Nov 2026: to see who's late with their reports). Clerks write it
 * many ways: 06.11.2026, 26-10-2026, 06 11 26, 281026, 2026.10.30, "3rd November 2026", "26th Oct 26", "W.C 191026",
 * "W.E 08.11.26", ranges ("19 10 26-22 10 26", "Visits 02 06 11 2026", "14 16.10.26"), no year ("04-11-Woodside")
 * and monthly reports ("October 2026", "Oct 26 Monthly").
 * A date up to 45 days before the upload counts as the visit (the latest one if there are several). A date in the week
 * after the upload is a week-ending date ("W.E", Sawston's "R72. 01.11.26"): the visits were in the week before it.
 * @returns {{ date: string, week?: "of" | "ending" } | { monthly: string } | null}
 */
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");
const year = (y) => (y.length === 2 ? 2000 + Number(y) : Number(y));
const DAY = 864e5;
const SEP = "(?:[.\\-/]|\\s(?=\\d))"; // a dot, dash or slash, or a space before the next number (not " - ")

/**
 * The visit date for a report: from its name, settled against the diary for weekly reports; from the diary when the
 * name has none (the latest visit to that job in the 14 days before the upload). Monthly reports have none.
 * @param {{ file_name: string, uploaded_at: string }} rep
 * @param {string[]} diaryDates that job's diary visit dates (that clerk's first, if known), any order
 * @returns {{ visit_date: string | null, visit_date_source: string }}
 */
export function visitDateFor(rep, diaryDates) {
  const upDay = rep.uploaded_at.slice(0, 10);
  const shift = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const lastIn = (from, to) => diaryDates.filter((d) => d >= from && d <= to && d <= upDay).sort().pop() ?? null;
  const x = parseNameDate(rep.file_name, rep.uploaded_at);
  if (x && "monthly" in x) return { visit_date: null, visit_date_source: "monthly" };
  if (x && x.week) {
    const [from, to] = x.week === "of" ? [x.date, shift(x.date, 6)] : [shift(x.date, -6), x.date];
    const d = lastIn(from, to);
    return d ? { visit_date: d, visit_date_source: "name+diary" } : { visit_date: to < upDay ? to : upDay, visit_date_source: "name" };
  }
  if (x) return { visit_date: x.date, visit_date_source: "name" };
  const d = lastIn(shift(upDay, -14), upDay);
  return d ? { visit_date: d, visit_date_source: "diary" } : { visit_date: null, visit_date_source: "unknown" };
}

export function parseNameDate(name, uploaded) {
  const up = Date.parse(`${uploaded.slice(0, 10)}T00:00:00Z`);
  const upYear = new Date(up).getUTCFullYear();
  const s = ` ${String(name).replace(/\.docx?$/i, "").replace(/,/g, ".").replace(/_/g, " ").replace(/([-\s])\.(?=\d)/g, "$1 ")} `;
  const found = [];
  const before = (i) => s.slice(Math.max(0, i - 14), i);
  const tag = (i) => (/w\.?\s*e\.?\s*$|week\s*ending\s*$/i.test(before(i)) ? "ending" : /w\.?\s*c\.?\s*$|w\/c\s*$|week\s*commencing\s*$/i.test(before(i)) ? "of" : null);
  const add = (d, m, y, i) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2020 && y <= 2035)) return;
    const iso = `${y}-${pad(m)}-${pad(d)}`;
    const t = Date.parse(`${iso}T00:00:00Z`);
    if (Number.isNaN(t) || new Date(t).getUTCDate() !== d) return;
    if (t > up + 8 * DAY || t < up - 45 * DAY) return;
    let week = i == null ? null : tag(i);
    if (t > up + DAY) week = "ending";
    found.push({ date: iso, ...(week ? { week } : {}) });
  };
  // 2026.10.30 / 2026-11-10
  for (const x of s.matchAll(/(?<!\d)(20\d\d)[.\-/ ](\d{1,2})[.\-/ ](\d{1,2})(?!\d)/g)) add(+x[3], +x[2], +x[1], x.index);
  // two days then month and year: "02 06 11 2026", "14 16.10.26", "19 22 10 2026"
  for (const x of s.matchAll(/(?<![\d.])(\d{1,2})\s+(\d{1,2})[.\s](\d{1,2})[.\s](\d{4}|\d{2})(?!\d)/g)) { add(+x[1], +x[3], year(x[4]), null); add(+x[2], +x[3], year(x[4]), null); }
  // 06.11.2026, 26-10-2026, 06 11 26, 3-8-26, 05.11.26
  for (const x of s.matchAll(new RegExp(`(?<![\\d.])(\\d{1,2})${SEP}(\\d{1,2})${SEP}(\\d{4}|\\d{2})(?!\\d)`, "g"))) add(+x[1], +x[2], year(x[3]), x.index);
  // 281026, 091126 (ddmmyy on its own)
  for (const x of s.matchAll(/(?<![\d.])(\d{2})(\d{2})(\d{2})(?![\d.])/g)) add(+x[1], +x[2], year(x[3]), x.index);
  // 3rd November 2026, 26th Oct 26, 16 November 26
  for (const x of s.matchAll(/(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s+(\d{4}|\d{2})(?!\d)/gi)) {
    const mo = MONTHS.indexOf(x[2].slice(0, 3).toLowerCase());
    if (mo >= 0) add(+x[1], mo + 1, year(x[3]), x.index);
  }
  if (found.length) {
    found.sort((a, b) => b.date.localeCompare(a.date));
    return found.find((f) => f.week) ?? found[0];
  }
  // a monthly report: "October 2026", "October26", "Oct 26 Monthly", "October monthly"
  // (the last month named wins: "Sept-October 2026 progress report" is October's)
  const months = [...s.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*((?:20)?\d\d)?(?!\d)/gi)];
  const mm = months.at(-1);
  if (mm && (mm[2] || months.some((x) => x[2]) || /month|progress/i.test(s))) {
    const mo = MONTHS.indexOf(mm[1].toLowerCase()) + 1;
    const yy = mm[2] ?? months.find((x) => x[2])?.[2];
    const y = yy ? year(yy) : mo > new Date(up).getUTCMonth() + 1 ? upYear - 1 : upYear;
    return { monthly: `${y}-${pad(mo)}` };
  }
  // a monthly report that doesn't say which month: the month before it was uploaded
  if (/month|progress report/i.test(s)) { const d = new Date(up); d.setUTCDate(0); return { monthly: d.toISOString().slice(0, 7) }; }
  // "04-11" with no year: the upload's year (or the year before, for a December report found in January)
  const nm = /(?<![\d.])(\d{1,2})[.\-](\d{1,2})(?![\d.]|-\d)/.exec(s);
  if (nm) { add(+nm[1], +nm[2], upYear, null); if (!found.length) add(+nm[1], +nm[2], upYear - 1, null); if (found.length) return found[0]; }
  return null;
}
