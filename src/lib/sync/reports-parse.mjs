/**
 * Readers for the two report files (ExcelJS workbooks), plain JavaScript so they can be tested with node.
 *  - "Beamore Reports Ready To Check" (Google Sheet, exported as xlsx): Word reports with no PDF yet.
 *    Columns: Checker | Main Folder | Project | Report Folder | Word Report Name | Report Date | Due Date | Date Created | Last Updated | Checker Match
 *  - "Beamore Report Turnaround Dashboard.xlsx", sheet "Report Log" (header row 5):
 *    Clerk | Project | Visit Date | Report Date | Working Days | Report Month | Status / Review | Report Name | Drive File ID | Checker | Checked At | Source Scan Finished
 */
const val = (cell) => {
  const v = cell?.value;
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") return "result" in v ? v.result ?? null : "richText" in v ? v.richText.map((t) => t.text).join("") : "text" in v ? v.text : null;
  return v;
};
const str = (c) => { const v = val(c); return v == null ? "" : v instanceof Date ? v.toISOString() : String(v).trim(); };
/** Dates arrive as real dates or as "05/11/2026 00:00" (UK) or "2026-11-05". */
const date = (c) => {
  const v = val(c);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const stamp = (c) => {
  const v = val(c);
  if (v instanceof Date) return v.toISOString();
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5]}:${m[6] ?? "00"}`;
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.replace(" ", "T") : null;
};
const num = (c) => { const n = Number(val(c)); return Number.isFinite(n) ? n : null; };

/** Finds the header row (within the first 10) by a column name, and maps header → column number. */
function headers(ws, mustHave) {
  for (let r = 1; r <= 10; r++) {
    const map = {};
    ws.getRow(r).eachCell((c, col) => { map[str(c).toLowerCase()] = col; });
    if (mustHave in map) return { row: r, col: map };
  }
  throw new Error(`"${ws.name}" has no "${mustHave}" column in its first 10 rows`);
}

export function parseQueue(wb) {
  const ws = wb.worksheets.find((w) => { try { headers(w, "word report name"); return true; } catch { return false; } });
  if (!ws) throw new Error("No sheet with a 'Word Report Name' column in the Ready To Check file");
  const { row, col } = headers(ws, "word report name");
  const out = [];
  for (let r = row + 1; r <= ws.rowCount; r++) {
    const x = ws.getRow(r);
    const name = str(x.getCell(col["word report name"]));
    if (!name) continue;
    out.push({
      checker: str(x.getCell(col["checker"])) || "Unknown",
      folder: str(x.getCell(col["report folder"])) || null,
      main_folder: str(x.getCell(col["main folder"])) || null,
      project_name: str(x.getCell(col["project"])),
      report_name: name,
      report_date: date(x.getCell(col["report date"])),
      due: date(x.getCell(col["due date"])),
    });
  }
  return out;
}

export function parseLog(wb) {
  const ws = wb.getWorksheet("Report Log");
  if (!ws) throw new Error('No "Report Log" sheet in the turnaround workbook');
  const { row, col } = headers(ws, "drive file id");
  const out = [];
  for (let r = row + 1; r <= ws.rowCount; r++) {
    const x = ws.getRow(r);
    const id = str(x.getCell(col["drive file id"]));
    if (!id) continue;
    const review = str(x.getCell(col["status / review"]));
    const [status, ...rest] = review.split(":");
    out.push({
      drive_file_id: id,
      clerk_name: str(x.getCell(col["clerk"])) || null,
      project_name: str(x.getCell(col["project"])) || null,
      visit_date: date(x.getCell(col["visit date"])),
      report_date: date(x.getCell(col["report date"])),
      working_days: num(x.getCell(col["working days"])),
      status: status.trim() || null,
      reason: rest.join(":").trim() || null,
      report_name: str(x.getCell(col["report name"])) || null,
      checker: str(x.getCell(col["checker"])) || null,
      checked_at: stamp(x.getCell(col["checked at"])),
    });
  }
  return out;
}
