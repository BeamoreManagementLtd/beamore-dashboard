/**
 * Reads the month-by-month days from a Beamore cost sheet (xlsx): a header row with the day columns
 * ("Regular Building Clerk", "M&E Clerk witness", "Regular CQM Lead", "Building Services…") ending in
 * "Total days", then one row per month with the month in column A. M&E / Building Services columns count as
 * M&E; specialists (architect, structural / civil / fire engineer, facades) as other; everything else (building clerk,
 * CQM lead, factory visits) as building. Witnessing / snagging / commissioning / defects columns are also counted in
 * building_witness or me_witness (part of building or me, shown apart on the Workload page). Returns [] if the sheet
 * isn't one.
 */
const OTHER = /architect|structural|civil|engineer|fa[cç]ade|fire compliance/i;
const WITNESS = /witness|snag|commission|defect|o\s*&\s*m\b|handover/i;
const ME =/\bM\s*&\s*E\b|building services|mechanical|electrical|\bMEP\b/i;
const text = (v) => {
  if (v == null) return "";
  if (typeof v === "object") { if (v instanceof Date) return v.toISOString(); if ("result" in v) return String(v.result ?? ""); if ("richText" in v) return v.richText.map((t) => t.text).join(""); if ("text" in v) return String(v.text); return ""; }
  return String(v);
};
const num = (v) => { const x = typeof v === "object" && v && "result" in v ? v.result : v; const n = Number(x); return Number.isFinite(n) ? n : 0; };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function monthOf(v) {
  if (v instanceof Date) return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const s = text(v).trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-01`;
  m = /^([a-z]{3})[a-z]*[\s\-']+(\d{2,4})$/.exec(s); // "Jun-26", "June 2026"
  if (m && MONTHS.includes(m[1])) { const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]); return `${y}-${String(MONTHS.indexOf(m[1]) + 1).padStart(2, "0")}-01`; }
  return null;
}

/** @returns {{ month: string, building: number, me: number, building_witness: number, me_witness: number, other: number }[]} */
export function parseCostSheet(wb) {
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
      const heads = [];
      for (let c = 1; c <= Math.min(ws.columnCount, 30); c++) heads.push(text(ws.getCell(r, c).value).trim());
      const totalCol = heads.findIndex((h) => /^total\s*(planned\s*)?(days|visits)?$/i.test(h) && /day|visit/i.test(h));
      if (totalCol < 0) continue;
      // day columns: between the month column and "Total days", skipping blanks and rates
      const cols = [];
      for (let c = 1; c < totalCol; c++) if (heads[c] && !/rate|cost|£|total/i.test(heads[c])) cols.push({ c: c + 1, kind: ME.test(heads[c]) ? "me" : OTHER.test(heads[c]) ? "other" : "building", witness: WITNESS.test(heads[c]) });
      if (!cols.length) continue;
      const out = new Map();
      for (let rr = r + 1; rr <= ws.rowCount; rr++) {
        const month = monthOf(ws.getCell(rr, 1).value);
        if (!month) continue;
        const row = out.get(month) ?? { month, building: 0, me: 0, building_witness: 0, me_witness: 0, other: 0 };
        for (const { c, kind, witness } of cols) {
          const d = num(ws.getCell(rr, c).value);
          row[kind] += d;
          if (witness && kind === "building") row.building_witness += d;
          if (witness && kind === "me") row.me_witness += d;
        }
        out.set(month, row);
      }
      const rows = [...out.values()].filter((x) => x.building || x.me || x.other);
      if (rows.length) return rows.sort((a, b) => a.month.localeCompare(b.month));
    }
  }
  return [];
}
