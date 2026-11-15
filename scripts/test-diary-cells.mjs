// Tests the diary cell patcher on a private COPY of the diary (never the real file):
//   node scripts/test-diary-cells.mjs <copy.xlsx>
import fs from "node:fs";
import JSZip from "jszip";
import { loadWorkbook } from "../src/lib/sync/load-workbook.mjs";
import { setCell, cellStyle, greenVersion } from "../src/lib/portal/diary-cells.mjs";

const raw = fs.readFileSync(process.argv[2]);
const zip = await JSZip.loadAsync(raw);
const wbXml = await zip.file("xl/workbook.xml").async("string");
const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
const rid = /<sheet\b[^>]*name="November"[^>]*r:id="([^"]+)"/.exec(wbXml)?.[1];
const target = new RegExp(String.raw`<Relationship\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(String.raw`<Relationship\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1];
const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
console.log("November is", path);
let xml = await zip.file(path).async("string");
const styles = await zip.file("xl/styles.xml").async("string");

// Adam King's block starts at row 39; pick its 2nd dated row and the Invoice received label (row 39+29 = 68)
const before = await loadWorkbook(raw);
const ws = before.getWorksheet("November");
const val = (c) => { const v = (c.master ?? c).value; return v && typeof v === "object" && !(v instanceof Date) ? (v.formula ? "=f" : v.richText ? v.richText.map((t) => t.text).join("") : v.text ?? v.result) : v; };
let row = 0; for (let r = 40; r < 70; r++) if (val(ws.getCell(r, 12)) instanceof Date && !val(ws.getCell(r, 13)) && !val(ws.getCell(r, 15))) { row = r; break; }
console.log("test row", row, val(ws.getCell(row, 11)), val(ws.getCell(row, 12)));
xml = setCell(xml, `M${row}`, "Test Site & Co");
xml = setCell(xml, `O${row}`, "Test Site & Co");
const st = cellStyle(xml, "T68");
const green = greenVersion(styles, Number(st.s));
console.log("T68 style", st.s, "-> green", green, "label:", val(ws.getCell(68, 20)));
if (green !== null) xml = xml.replace(st.tag, st.tag.replace(/\bs="\d+"/, `s="${green}"`));
zip.file(path, xml);
const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });

// checks: values landed; formulas next to them intact; every other part identical in content
const after = await loadWorkbook(out);
const w2 = after.getWorksheet("November");
console.log("M/O now:", val(w2.getCell(row, 13)), "|", val(w2.getCell(row, 15)), "| cost cells:", val(w2.getCell(row, 14)), val(w2.getCell(row, 16)));
const z2 = await JSZip.loadAsync(out);
const changed = [];
for (const n of Object.keys(zip.files)) {
  if (zip.files[n].dir) continue;
  const a = await (await JSZip.loadAsync(raw)).file(n).async("nodebuffer"), b = await z2.file(n).async("nodebuffer");
  if (!a.equals(b)) changed.push(n);
}
console.log("parts changed:", changed.join(", "), "| size", raw.length, "->", out.length);
// the rest of the November sheet: same number of cells and formulas as before
const count = (x) => [(x.match(/<c\b/g) ?? []).length, (x.match(/<f\b/g) ?? []).length];
console.log("cells/formulas before", count(await (await JSZip.loadAsync(raw)).file(path).async("string")), "after", count(xml));
