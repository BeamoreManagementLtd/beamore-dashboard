/**
 * Adds a new tab to an .xlsx (a JSZip of it) without touching any other part except the workbook's list of tabs, its
 * links and content types. The tab goes at the end, so nothing that refers to other tabs by position changes.
 * Plain JavaScript so it can be tested with node.
 */
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

/**
 * rows: arrays of strings, the first is the header. styles: { head, body } cellXfs indexes. widths: column widths.
 * freeze: { cols, rows } to keep in view when scrolling.
 */
export async function addSheet(zip, name, rows, { styles = {}, widths = [], freeze } = {}) {
  let wb = await zip.file("xl/workbook.xml").async("string");
  if (new RegExp(`<(?:\\w+:)?sheet\\b[^>]*name="${escXml(name)}"`).test(wb)) throw new Error(`There's already a tab called ${name}`);
  let rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  let types = await zip.file("[Content_Types].xml").async("string");

  let n = 1; while (zip.file(`xl/worksheets/sheet${n}.xml`)) n++;
  const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const rid = `rId${Math.max(0, ...ids) + 1}`;
  const sheetId = Math.max(0, ...[...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*sheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;

  const width = Math.max(...rows.map((r) => r.length));
  const cell = (r, c, v, s) => {
    const ref = `${col(c)}${r}`, st = s != null ? ` s="${s}"` : "";
    return v === "" || v == null ? `<c r="${ref}"${st}/>` : `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
  };
  const data = rows.map((row, i) => `<row r="${i + 1}">${Array.from({ length: width }, (_, c) => cell(i + 1, c + 1, row[c] ?? "", i === 0 ? styles.head : styles.body)).join("")}</row>`).join("");
  const pane = freeze ? `<pane${freeze.cols ? ` xSplit="${freeze.cols}"` : ""}${freeze.rows ? ` ySplit="${freeze.rows}"` : ""} topLeftCell="${col((freeze.cols ?? 0) + 1)}${(freeze.rows ?? 0) + 1}" activePane="bottomRight" state="frozen"/>` : "";
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${col(width)}${rows.length}"/><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${data}</sheetData>` +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  zip.file(`xl/worksheets/sheet${n}.xml`, xml, { createFolders: false });

  const pre = /<((?:\w+:)?)sheets>/.exec(wb)?.[1] ?? "";
  const rPre = /xmlns:(\w+)="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/.exec(wb)?.[1] ?? "r";
  wb = wb.replace(`</${pre}sheets>`, `<${pre}sheet name="${escXml(name)}" sheetId="${sheetId}" ${rPre}:id="${rid}"/></${pre}sheets>`);
  rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/></Relationships>`);
  types = types.replace("</Types>", `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("xl/workbook.xml", wb, { createFolders: false });
  zip.file("xl/_rels/workbook.xml.rels", rels, { createFolders: false });
  zip.file("[Content_Types].xml", types, { createFolders: false });
  return `xl/worksheets/sheet${n}.xml`;
}
