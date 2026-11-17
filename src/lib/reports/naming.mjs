/**
 * Report file names follow the folder's own pattern (Ronan, 15 Nov 2026: "make sure the name follows the naming
 * convention of all the other reports"). Each project names its reports its own way ("95 - Highams Park - CoW Diary -
 * 12.11.2026", "SRP1065-BML-XX-XX-T-O-5040-CoW_FAB_62_03.11.2026", "113 - Fred Longworths DfE diary 9.11.26"), so the
 * pattern is learnt from the reports already in the folder: everything stays the same except the report number (next
 * in sequence) and the visit date (written the same way). Only when the earlier names clearly share one pattern.
 * Plain JavaScript so it can be tested with node.
 */
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const base = (n) => n.replace(/\.(docx?|pdf)$/i, "").replace(/\s*\(\d+\)\s*$/, "").replace(/(\s+copy)+$/i, "");

/** Finds the date in a name and how it's written. */
function findDate(s) {
  const tries = [
    { re: /(?<!\d)(\d{1,2})([.\-_ ])(\d{1,2})\2(\d{4}|\d{2})(?!\d)/, kind: "dmy" },
    // "30- 09- 2026" (Preece House's building reports, which the renamer couldn't read, 17 Nov 2026)
    { re: /(?<!\d)(\d{1,2})([.\-_] )(\d{1,2})\2(\d{4}|\d{2})(?!\d)/, kind: "dmy" },
    { re: /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/, kind: "iso" },
    { re: /(?<!\d)(\d{1,2})(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\w*\s+(\d{4})/i, kind: "long" },
    { re: /(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/, kind: "compact" },
  ];
  for (const t of tries) {
    const m = t.re.exec(s);
    if (!m) continue;
    let d, mo, y, fmt;
    if (t.kind === "dmy") { d = +m[1]; mo = +m[3]; y = +(m[4].length === 2 ? `20${m[4]}` : m[4]); fmt = { kind: "dmy", sep: m[2], dPad: m[1].length === 2, mPad: m[3].length === 2, yLen: m[4].length }; }
    else if (t.kind === "iso") { y = +m[1]; mo = +m[2]; d = +m[3]; fmt = { kind: "iso" }; }
    else if (t.kind === "long") { d = +m[1]; mo = MONTHS.findIndex((x) => x.startsWith(m[3].toLowerCase().slice(0, 3))) + 1; y = +m[4]; fmt = { kind: "long", suffix: !!m[2], short: m[3].length <= 4 && !/^(june|july)$/i.test(m[3]), cap: m[3][0] === m[3][0].toUpperCase() }; }
    else { d = +m[1]; mo = +m[2]; y = +`20${m[3]}`; fmt = { kind: "compact" }; }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2015 || y > 2040) continue;
    return { iso: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, at: m.index, len: m[0].length, fmt };
  }
  return null;
}
const ord = (d) => (d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th");
function writeDate(iso, f) {
  const [y, m, d] = iso.split("-").map(Number);
  if (f.kind === "iso") return iso;
  if (f.kind === "compact") return `${String(d).padStart(2, "0")}${String(m).padStart(2, "0")}${String(y).slice(2)}`;
  if (f.kind === "long") {
    let mon = MONTHS[m - 1]; if (f.short) mon = mon.slice(0, 3); if (f.cap) mon = mon[0].toUpperCase() + mon.slice(1);
    return `${d}${f.suffix ? ord(d) : ""} ${mon} ${y}`;
  }
  return `${f.dPad ? String(d).padStart(2, "0") : d}${f.sep}${f.mPad ? String(m).padStart(2, "0") : m}${f.sep}${f.yLen === 2 ? String(y).slice(2) : y}`;
}

/** A name split into: fixed text, the date, and the numbers (one of which is the report number). */
function parse(name) {
  const b = base(name);
  const date = findDate(b);
  if (!date) return null;
  const parts = [], nums = [];
  const pushText = (t) => {
    let last = 0;
    for (const m of t.matchAll(/\d+/g)) { if (m.index > last) parts.push({ text: t.slice(last, m.index) }); nums.push(parts.length); parts.push({ num: m[0] }); last = m.index + m[0].length; }
    if (last < t.length) parts.push({ text: t.slice(last) });
  };
  pushText(b.slice(0, date.at));
  parts.push({ date: true, fmt: date.fmt });
  pushText(b.slice(date.at + date.len));
  const skeleton = parts.map((p) => (p.date ? "{D}" : p.num !== undefined ? "{N}" : p.text.replace(/\s+/g, " ").toLowerCase())).join("");
  return { b, parts, nums, date, skeleton };
}

/**
 * The name this report should have, or null to leave it (no clear pattern, or already right).
 * siblings: the other report names in the folder, newest first. number: the report's own number if known.
 */
export function conventionName(current, siblings, visitDate, number) {
  const ext = (/\.(docx?|pdf)$/i.exec(current)?.[0] ?? ".docx").toLowerCase();
  const seen = new Set(), sib = [];
  for (const s of siblings) { const p = parse(s); if (p && !seen.has(p.b.toLowerCase()) && p.b.toLowerCase() !== base(current).toLowerCase()) { seen.add(p.b.toLowerCase()); sib.push(p); } }
  if (sib.length < 2) return null;
  // the pattern most of the last five share, and at least two of them
  const recent = sib.slice(0, 5), counts = new Map();
  for (const p of recent) counts.set(p.skeleton, (counts.get(p.skeleton) ?? 0) + 1);
  let [skel, n] = [...counts].sort((a, b) => b[1] - a[1])[0];
  // a folder with two series (Preece House: M&E reports named one way, building reports another): a name already in the
  // style of one of them stays in that style
  const mine = parse(current)?.skeleton;
  if (mine && mine !== skel && sib.filter((p) => p.skeleton === mine).length >= 2) { skel = mine; n = 2; }
  else if (n < 2 || n < Math.ceil(recent.length / 2)) return null;
  const same = sib.filter((p) => p.skeleton === skel);
  const latest = same[0];
  // the report number: the number in the pattern that goes up from one report to the next
  let pos = null;
  for (const k of latest.nums) {
    const vals = same.slice(0, 4).map((p) => +p.parts[k].num);
    if (vals.length >= 2 && vals.every((v, i) => i === 0 || vals[i - 1] > v)) { pos = k; break; }
  }
  if (pos === null) return null;
  const date = visitDate && /^\d{4}-\d{2}-\d{2}$/.test(visitDate) ? visitDate : parse(current)?.date.iso;
  if (!date) return null;
  // the series counts every numbered report in the folder, whatever style it's named in, when the number leads the name
  // (Preece House: M&E reports up to 68 named one way, building reports 69-73 another, so 74 came out as 69, 17 Nov 2026)
  const leads = latest.nums[0] === pos && latest.parts.slice(0, pos).every((p) => p.text !== undefined && !p.text.trim());
  const leading = (s) => +(/^\s*0*(\d{1,4})(?!\d)/.exec(base(s))?.[1] ?? 0);
  const highest = Math.max(...same.map((p) => +p.parts[pos].num), ...(leads ? siblings.map(leading) : []));
  const own = number && /^\d{1,4}$/.test(String(number).replace(/^0+/, "") || "0") ? +number : 0;
  // the number written in the report and the one the clerk gave the file agree: that's the number, never changed
  const agreed = own > 0 && leads && leading(current) === own;
  const want = agreed ? own : own > 0 && own <= highest + 5 ? own : highest + 1;
  const width = latest.parts[pos].num.length, padded = latest.parts[pos].num.startsWith("0") || same.some((p) => p.parts[pos].num.startsWith("0"));
  const out = latest.parts.map((p, k) => (p.date ? writeDate(date, p.fmt) : k === pos ? (padded ? String(want).padStart(width, "0") : String(want)) : p.num ?? p.text)).join("");
  return `${out}${ext}` === current ? null : `${out}${ext}`;
}
