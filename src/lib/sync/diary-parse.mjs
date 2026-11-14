/**
 * Reads Diary 2026.xlsx (an ExcelJS workbook) into plain rows. Plain JavaScript so it can be tested with node.
 *
 * Layout (Ronan's diary):
 *  - One sheet per month. Row 2 holds slot headers: "1st location | Cost | 2nd location | Cost | 3rd location | Cost | Comments".
 *  - Months with one set of headers have only the salmon side (what clerks charge). From November 2026 there are two:
 *    the left (grey) is planned visits, the right (salmon) is what was charged.
 *  - Each clerk has a block: name in the column two left of "1st location", one row per day of the month starting at the
 *    block's first row. Rows without a date are weekends and still count. Every filled slot is half a day.
 *  - "(M&E)" in a site name means an M&E visit; anything else is building.
 *  - Row 1 has "INVOICES" above the client invoice table: invoice number one column to the left, then site, days, rate, total.
 */
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const HEADER = /^(1st|2nd|3rd) location$|^cost$|^comments$|^vat$|^total$|^gross$/i;
const ABSENCE = /holiday|annual leave|\ba\/l\b|\bon leave\b|\bsick\b|\bday off\b/i;

const val = (cell) => {
  const v = cell?.value;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return v.result ?? null;
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return v.text;
    return null;
  }
  return v;
};
const str = (cell) => { const v = val(cell); return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""; };
const num = (cell) => { const v = val(cell); const n = typeof v === "number" ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const iso = (d) => d.toISOString().slice(0, 10);
const kindOf = (site) => (/m&e/i.test(site) ? "me" : "building");

export function parseDiary(wb, { year = 2026, fileLabel = "Diary 2026.xlsx" } = {}) {
  const visits = [], absences = [], invoiceLines = [], clerks = new Set();
  for (let m = 0; m < 12; m++) {
    const ws = wb.getWorksheet(MONTHS[m]);
    if (!ws) continue;
    const days = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
    const header = ws.getRow(2);
    const starts = [];
    header.eachCell((c, col) => { if (/^1st location$/i.test(str(c))) starts.push(col); });
    const sides = starts.map((s, i) => ({ s, side: starts.length > 1 && i === 0 ? "planned" : "charged" }));

    for (const { s, side } of sides) {
      const nameCol = s - 2, dateCol = s - 1;
      let block = null;
      const flush = () => {
        if (!block) return;
        // anchor the block's day numbering on any dated row
        const anchor = block.rows.find((r) => r.date);
        if (!anchor) { block = null; return; }
        const first = new Date(Date.UTC(anchor.date.getUTCFullYear(), anchor.date.getUTCMonth(), anchor.date.getUTCDate() - (anchor.r - block.start)));
        for (const row of block.rows) {
          const offset = row.r - block.start;
          if (offset < 0 || offset >= days) continue;
          const d = new Date(first.getTime() + offset * 86400000);
          if (d.getUTCMonth() !== m) continue;
          for (const slot of row.slots) visits.push({ date: iso(d), clerk: block.clerk, site: slot.site, kind: kindOf(slot.site), side, cost: slot.cost, sheet: `${fileLabel} / ${MONTHS[m]}`, row: row.r });
          if (side === "charged" && row.comment && ABSENCE.test(row.comment))
            absences.push({ clerk: block.clerk, date: iso(d), kind: /sick/i.test(row.comment) ? "Sick" : "Holiday", note: row.comment });
        }
        block = null;
      };
      for (let r = 3; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const nameCell = row.getCell(nameCol);
        // the clerk's name is merged down the whole block: only its top cell starts a block
        const name = nameCell.isMerged && nameCell.master.address !== nameCell.address ? "" : str(nameCell);
        if (/^1st location$/i.test(str(row.getCell(s)))) { flush(); continue; }
        if (name && !HEADER.test(name) && isNaN(Number(name))) {
          flush();
          block = { clerk: name, start: r, rows: [] };
          clerks.add(name);
        }
        if (!block) continue;
        const dv = val(row.getCell(dateCol));
        const slots = [];
        for (const c of [s, s + 2, s + 4]) {
          const site = str(row.getCell(c));
          if (site && !HEADER.test(site) && isNaN(Number(site))) slots.push({ site, cost: num(row.getCell(c + 1)) });
        }
        block.rows.push({ r, date: dv instanceof Date ? dv : null, slots, comment: str(row.getCell(s + 6)) });
      }
      flush();
    }

    // client invoice table
    let invCol = null;
    ws.getRow(1).eachCell((c, col) => { if (/^invoices$/i.test(str(c))) invCol = col; });
    if (invCol) {
      for (let r = 2; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const number = str(row.getCell(invCol - 1)), site = str(row.getCell(invCol)), d = num(row.getCell(invCol + 1));
        if (/^[A-Z0-9]+-\d+/i.test(number) && site && d) invoiceLines.push({ month: MONTHS[m], number: number.split(/\s/)[0], site, kind: kindOf(site), days: d, rate: num(row.getCell(invCol + 2)) });
      }
    }
  }

  const rates = [];
  const rs = wb.getWorksheet("Rates");
  if (rs) for (let r = 3; r <= rs.rowCount; r++) {
    const row = rs.getRow(r), site = str(row.getCell(1));
    if (site) rates.push({ site, charge: num(row.getCell(2)), pay: num(row.getCell(3)) });
  }
  return { visits, absences, invoiceLines, rates, clerks: [...clerks] };
}
