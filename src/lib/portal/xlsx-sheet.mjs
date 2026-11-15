/**
 * Adds (or replaces) one tab in an .xlsx (a JSZip of it) without touching any other tab. Only the workbook's list of
 * tabs, its links, the content types and (when new styles are needed) the end of the style list change. A new tab goes
 * at the end, so nothing that refers to other tabs by position changes. Plain JavaScript so it can be tested with node.
 */
const escXml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const col = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const NO_FOLDERS = { createFolders: false };

/**
 * Cell styles with a solid background: [{ font: fontId (copied from an existing style), rgb: "FFF3F3F3" | null }].
 * Reuses a matching style if the file already has one, otherwise adds it at the end. Returns the style indexes.
 */
export async function solidStyles(zip, defs) {
  let styles = await zip.file("xl/styles.xml").async("string");
  const fillsM = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(styles);
  const fills = [...fillsM[1].matchAll(/<fill>[\s\S]*?<\/fill>|<fill\/>/g)].map((m) => m[0]);
  const xfsM = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
  const xfs = [...xfsM[1].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((m) => m[0]);
  const newFills = [], newXfs = [];
  const out = defs.map(({ font, rgb }) => {
    let fillId = 0;
    if (rgb) {
      fillId = fills.findIndex((f) => /patternType="solid"/.test(f) && new RegExp(`fgColor rgb="${rgb}"`, "i").test(f));
      if (fillId < 0) { fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${rgb}"/><bgColor indexed="64"/></patternFill></fill>`); newFills.push(fills.at(-1)); fillId = fills.length - 1; }
    }
    const want = `<xf numFmtId="0" fontId="${font}" fillId="${fillId}" borderId="0" xfId="0" applyFont="1"${fillId ? ' applyFill="1"' : ""}/>`;
    let i = xfs.indexOf(want);
    if (i < 0) { xfs.push(want); newXfs.push(want); i = xfs.length - 1; }
    return i;
  });
  if (newFills.length || newXfs.length) {
    styles = styles.replace(fillsM[0], fillsM[0].replace(/count="\d+"/, `count="${fills.length}"`).replace("</fills>", `${newFills.join("")}</fills>`));
    const xm = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles);
    styles = styles.replace(xm[0], xm[0].replace(/count="\d+"/, `count="${xfs.length}"`).replace("</cellXfs>", `${newXfs.join("")}</cellXfs>`));
    zip.file("xl/styles.xml", styles, NO_FOLDERS);
  }
  return out;
}

/** The style index a cell uses (e.g. to copy a font from another tab). */
export const fontOf = async (zip, styleIndex) => {
  const styles = await zip.file("xl/styles.xml").async("string");
  const xfs = [.../<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)[1].matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((m) => m[0]);
  return /fontId="(\d+)"/.exec(xfs[styleIndex] ?? "")?.[1] ?? "0";
};

/** Where a tab's XML lives inside the file, or null. */
export async function sheetPath(zip, name) {
  const wb = await zip.file("xl/workbook.xml").async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const rid = new RegExp(`<(?:\\w+:)?sheet\\b[^>]*name="${escXml(name)}"[^>]*r:id="([^"]+)"`).exec(wb)?.[1];
  const target = rid && (new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1]);
  return target ? (target.startsWith("/") ? target.slice(1) : `xl/${target}`) : null;
}

/**
 * rows: arrays of strings, the first is the header. styleOf(rowIndex, colIndex) -> cellXfs index (or styles: { head, body }).
 * widths: column widths. freeze: { cols, rows } kept in view when scrolling. replace: true rewrites the tab if it exists.
 */
export async function addSheet(zip, name, rows, { styles = {}, styleOf, widths = [], freeze, replace = false } = {}) {
  let wb = await zip.file("xl/workbook.xml").async("string");
  const existing = await sheetPath(zip, name);
  if (existing && !replace) throw new Error(`There's already a tab called ${name}`);

  const width = Math.max(...rows.map((r) => r.length));
  const st = styleOf ?? ((i) => (i === 0 ? styles.head : styles.body));
  const cell = (r, c, v, s) => {
    const ref = `${col(c)}${r}`, sa = s != null ? ` s="${s}"` : "";
    return v === "" || v == null ? `<c r="${ref}"${sa}/>` : `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
  };
  const data = rows.map((row, i) => `<row r="${i + 1}">${Array.from({ length: width }, (_, c) => cell(i + 1, c + 1, row[c] ?? "", st(i, c))).join("")}</row>`).join("");
  const pane = freeze ? `<pane${freeze.cols ? ` xSplit="${freeze.cols}"` : ""}${freeze.rows ? ` ySplit="${freeze.rows}"` : ""} topLeftCell="${col((freeze.cols ?? 0) + 1)}${(freeze.rows ?? 0) + 1}" activePane="bottomRight" state="frozen"/>` : "";
  const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${col(width)}${rows.length}"/><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${data}</sheetData>` +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  if (existing) { zip.file(existing, xml, NO_FOLDERS); return existing; }

  let rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  let types = await zip.file("[Content_Types].xml").async("string");
  let n = 1; while (zip.file(`xl/worksheets/sheet${n}.xml`)) n++;
  const rid = `rId${Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]))) + 1}`;
  const sheetId = Math.max(0, ...[...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*sheetId="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  zip.file(`xl/worksheets/sheet${n}.xml`, xml, NO_FOLDERS);
  const pre = /<((?:\w+:)?)sheets>/.exec(wb)?.[1] ?? "";
  const rPre = /xmlns:(\w+)="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/.exec(wb)?.[1] ?? "r";
  wb = wb.replace(`</${pre}sheets>`, `<${pre}sheet name="${escXml(name)}" sheetId="${sheetId}" ${rPre}:id="${rid}"/></${pre}sheets>`);
  rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/></Relationships>`);
  types = types.replace("</Types>", `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  zip.file("xl/workbook.xml", wb, NO_FOLDERS);
  zip.file("xl/_rels/workbook.xml.rels", rels, NO_FOLDERS);
  zip.file("[Content_Types].xml", types, NO_FOLDERS);
  return `xl/worksheets/sheet${n}.xml`;
}
