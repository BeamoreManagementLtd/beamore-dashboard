/**
 * Builds next year's diary from this year's (Ronan, 15 Nov 2026: "basically a copy of the 2026 diary, but with the
 * changes to November and December made across the board").
 *
 *   node scripts/build-diary-year.mjs "<Diary 2026.xlsx>" 2027 "<Diary 2027.xlsx>" [template month, default November]
 *
 * Every month of the new year is a copy of the template month (November 2026: the grey planned side and the salmon
 * charged side, company names under clerks' names, the Invoice received/checked/Put on Xero boxes, the client invoice
 * tables), with:
 *  - the new month's dates on both sides, weekdays only, one row per day as now (31 rows per clerk)
 *  - everything typed in cleared: sites, comments, holidays; the formulas, colours, merged name cells and the client
 *    invoice tables (client names, their sites, rate formulas) are kept
 *  - the Invoice received / checked / Put on Xero boxes back to their normal colour (not green)
 * The other tabs (Rates, Contact details, Projects, and the older ones) are copied as they are. The source file is
 * only read. Works on the .xlsx's XML directly so nothing else about the file changes.
 */
import fs from "node:fs";
import JSZip from "jszip";

const [src, yearArg, out, templateMonth = "November"] = process.argv.slice(2);
const YEAR = Number(yearArg);
if (!src || !out || !YEAR) { console.error("usage: build-diary-year.mjs <source.xlsx> <year> <out.xlsx> [template month]"); process.exit(1); }
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const zip = await JSZip.loadAsync(fs.readFileSync(src));
const wbXml = await zip.file("xl/workbook.xml").async("string");
const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
const pathOf = (name) => {
  const rid = new RegExp(`<sheet\\b[^>]*name="${name}"[^>]*r:id="([^"]+)"`).exec(wbXml)?.[1];
  const t = rid && (new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1]);
  if (!t) throw new Error(`no ${name} sheet`);
  return t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^xl\//, "")}`;
};
const template = await zip.file(pathOf(templateMonth)).async("string");

// ---- the template's clerk blocks: a name in column A starts a block; its 31 day rows follow from that row
const blockStarts = [...template.matchAll(/<c r="A(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g)].filter((m) => m[4] && /<v>|<is>/.test(m[4])).map((m) => Number(m[1])).filter((r) => r >= 3);
if (blockStarts.length < 5) throw new Error(`only ${blockStarts.length} clerk blocks found in ${templateMonth}`);
const dayRow = new Map(); // row -> day index 0..30
for (const s of blockStarts) for (let i = 0; i < 31; i++) dayRow.set(s + i, i);

// ---- which columns are which, from the header row (row 2): both sides' slots, costs and comments
// (empty cells are written <c .../>, so the pattern must not run on into the next cell)
const CELL = /<c r="([A-Z]+)(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
const headerCells = Object.fromEntries([...template.matchAll(CELL)].filter((m) => m[2] === "2" && m[5]).map((m) => [m[1], { attrs: m[3], inner: m[5] }]));
const ss = [...(await zip.file("xl/sharedStrings.xml").async("string")).matchAll(/<si>([\s\S]*?)<\/si>/g)]
  .map((m) => (m[1].match(/<t[^>]*>([^<]*)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join(""));
const textIn = (attrs, inner) => {
  const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
  if (/t="s"/.test(attrs) && v !== undefined) return ss[Number(v)] ?? "";
  return (/<t[^>]*>([^<]*)<\/t>/.exec(inner)?.[1] ?? v ?? "").replace(/&amp;/g, "&");
};
const firstLoc = Object.entries(headerCells).filter(([, c]) => /^1st location$/i.test(textIn(c.attrs, c.inner).trim())).map(([c]) => c);
const colNum = (c) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colName = (n) => { let s = ""; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
// the 1st location columns may not show up via shared strings above if inline; fall back to scanning texts
const sideStarts = (firstLoc.length ? firstLoc : []).map(colNum).sort((a, b) => a - b);
if (sideStarts.length !== 2) throw new Error(`expected two sides in ${templateMonth}, found ${sideStarts.length}`);
const dateCols = new Set(sideStarts.map((s) => colName(s - 1)));
// typed-in columns on each side: the three slots and Comments (s, s+2, s+4, s+6)
const typedCols = new Set(sideStarts.flatMap((s) => [s, s + 2, s + 4, s + 6].map(colName)));
const boxCol = colName(sideStarts[1] + 7); // Invoice received / checked / Put on Xero
const HEADER = /^(1st|2nd|3rd) location$|^cost$|^comments$|^vat$|^total$|^gross$/i;

// the boxes' normal (not green) style: the most common style among them
const boxStyles = {};
for (const m of template.matchAll(CELL)) {
  if (m[1] !== boxCol || !m[5] || !/invoice received|invoice checked|put on xero/i.test(textIn(m[3], m[5]))) continue;
  const s = /s="(\d+)"/.exec(m[3])?.[1]; if (s) boxStyles[s] = (boxStyles[s] ?? 0) + 1;
}
const boxStyle = Object.entries(boxStyles).sort((a, b) => b[1] - a[1])[0]?.[0];

const serial = (y, m, d) => (Date.UTC(y, m, d) - Date.UTC(1899, 11, 30)) / 864e5;
const stats = { cleared: 0, dates: 0, boxesReset: 0 };

function buildMonth(m) {
  const days = new Date(Date.UTC(YEAR, m + 1, 0)).getUTCDate();
  let x = template.replace(/<c r="([A-Z]+)(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g, (whole, col, rowS, attrs, _end, inner = "") => {
    const row = Number(rowS);
    const keepAttrs = attrs.replace(/\s+t="[^"]*"/, "");
    // dates on both sides
    if (dateCols.has(col) && dayRow.has(row)) {
      const i = dayRow.get(row);
      const d = new Date(Date.UTC(YEAR, m, i + 1));
      if (i < days && d.getUTCDay() !== 0 && d.getUTCDay() !== 6) { stats.dates++; return `<c r="${col}${row}"${keepAttrs}><v>${serial(YEAR, m, i + 1)}</v></c>`; }
      return `<c r="${col}${row}"${keepAttrs}/>`;
    }
    // formulas stay, without last year's calculated results (worked out again on opening)
    if (/<f[ >\/]/.test(inner)) return `<c r="${col}${row}"${keepAttrs.replace(/\s+t="[^"]*"/, "")}>${inner.replace(/<v>[^<]*<\/v>/, "")}</c>`;
    // what people typed in the slots and comments: cleared (headers stay)
    if (typedCols.has(col) && row > 2 && inner && !HEADER.test(textIn(attrs, inner).trim())) { stats.cleared++; return `<c r="${col}${row}"${keepAttrs}/>`; }
    // the invoice boxes back to their normal colour
    if (col === boxCol && boxStyle && /invoice received|invoice checked|put on xero/i.test(textIn(attrs, inner)) && !new RegExp(`s="${boxStyle}"`).test(attrs)) {
      stats.boxesReset++;
      return `<c r="${col}${row}"${attrs.replace(/s="\d+"/, `s="${boxStyle}"`)}>${inner}</c>`;
    }
    return whole;
  });
  // open at the top; only January is the selected tab
  x = x.replace(/<sheetView\b[^>]*?(\/?)>/, (_, close) => `<sheetView ${m === 0 ? 'tabSelected="1" ' : ""}workbookViewId="0"${close}>`)
    .replace(/<selection [^>]*\/>/, '<selection activeCell="A1" sqref="A1"/>');
  return x;
}

for (let m = 0; m < 12; m++) zip.file(pathOf(MONTHS[m]), buildMonth(m));
// the other tabs aren't the selected one either
for (const name of [...wbXml.matchAll(/<sheet\b[^>]*name="([^"]+)"/g)].map((x) => x[1]).filter((n) => !MONTHS.includes(n))) {
  const p = pathOf(name);
  zip.file(p, (await zip.file(p).async("string")).replace(/\s+tabSelected="1"/, ""));
}
// workbook opens on January; Excel rebuilds the calculation chain and recalculates everything on opening
let wb2 = wbXml.replace(/firstSheet="\d+"/, 'firstSheet="0"').replace(/activeTab="\d+"/, 'activeTab="0"')
  .replace(/<calcPr\b([^>]*?)\/>/, (_, a) => `<calcPr${a.replace(/\s+fullCalcOnLoad="[^"]*"/, "")} fullCalcOnLoad="1"/>`);
zip.file("xl/workbook.xml", wb2);
if (zip.file("xl/calcChain.xml")) {
  zip.remove("xl/calcChain.xml");
  zip.file("[Content_Types].xml", (await zip.file("[Content_Types].xml").async("string")).replace(/<Override PartName="\/xl\/calcChain.xml"[^>]*\/>/, ""));
  zip.file("xl/_rels/workbook.xml.rels", rels.replace(/<Relationship [^>]*Target="calcChain.xml"[^>]*\/>/, ""));
}
const core = zip.file("docProps/core.xml");
if (core) zip.file("docProps/core.xml", (await core.async("string")).replace(/<dc:title>[^<]*<\/dc:title>/, `<dc:title>Diary ${YEAR}</dc:title>`));

fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
console.log(JSON.stringify({ out, year: YEAR, template: templateMonth, clerkBlocks: blockStarts.length, sides: sideStarts.map(colName), dateCols: [...dateCols], boxCol, boxStyle, ...stats }));
