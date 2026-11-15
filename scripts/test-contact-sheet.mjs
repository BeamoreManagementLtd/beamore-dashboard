// Dry run of the Contact details writer on a LOCAL copy of the diary: node scripts/test-contact-sheet.mjs <diary.xlsx> <out.xlsx>
// Uses the dashboard's real clerk data (read only). Checks that only the Contact details sheet changes.
import fs from "node:fs";
import JSZip from "jszip";
import { createClient } from "@supabase/supabase-js";
import { loadWorkbook } from "../src/lib/sync/load-workbook.mjs";
import { setCell, setColWidths, cellStyle } from "../src/lib/portal/diary-cells.mjs";
import { contactRows, CONTACT_HEADERS, CONTACT_COLS } from "../src/lib/portal/contact-sheet.mjs";

for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const [{ data: cl }, { data: links }] = await Promise.all([
  db.from("clerks").select("id,name,email,personal_email,phone,clerk_compliance(address,next_of_kin_name,next_of_kin_relationship,next_of_kin_phone,emergency_contact,company_name,dbs_level,dbs_checked,dbs_update_service,ppe_notes,details_completed_at)").eq("active", true),
  db.from("clerk_companies").select("clerk_id,company_name").eq("kind", "own").eq("status", "Enabled"),
]);
const clerks = cl.map((c) => { const k = [c.clerk_compliance].flat()[0] ?? null; return { name: c.name, email: c.email, personal_email: c.personal_email, phone: c.phone, self_entered: !!k?.details_completed_at, companies: [...new Set(links.filter((l) => l.clerk_id === c.id).map((l) => l.company_name))], compliance: k }; });

const [src, dst] = process.argv.slice(2);
const raw = fs.readFileSync(src);
const text = (c) => { const v = c.value; if (v == null) return ""; if (typeof v === "object") return v.richText ? v.richText.map((t) => t.text).join("") : String(v.text ?? v.result ?? ""); return String(v); };
const ws = (await loadWorkbook(raw)).getWorksheet("Contact details");
const current = []; for (let r = 2; r <= ws.rowCount; r++) current.push(Array.from({ length: CONTACT_COLS }, (_, i) => text(ws.getCell(r, i + 1)).trim()));
let last = current.length; while (last > 0 && !current[last - 1][0] && !current[last - 1][1]) last--;
const want = contactRows(current.slice(0, last), clerks);
const COL = "ABCDEFGHIJK", changes = [];
CONTACT_HEADERS.forEach((h, i) => { if (text(ws.getCell(1, i + 1)).trim() !== h) changes.push({ ref: `${COL[i]}1`, value: h }); });
for (let r = 0; r < Math.max(want.length, last); r++) for (let i = 0; i < CONTACT_COLS; i++) { const w = want[r]?.[i] ?? "", n = current[r]?.[i] ?? ""; if (w !== n) changes.push({ ref: `${COL[i]}${r + 2}`, value: w }); }
console.log(`rows before ${last}, after ${want.length}; ${changes.length} cells change`);

const zip = await JSZip.loadAsync(raw);
const p = "xl/worksheets/sheet17.xml";
let xml = await zip.file(p).async("string");
const head = cellStyle(xml, "A1").s, body = cellStyle(xml, "A2").s, phone = cellStyle(xml, "E3").s;
for (const c of changes) xml = setCell(xml, c.ref, c.value, c.value ? (c.ref.endsWith("1") && c.ref.length === 2 ? head : c.ref[0] === "E" ? phone : body) : undefined);
xml = setColWidths(xml, { 6: 30, 7: 45, 8: 30, 9: 18, 10: 28, 11: 32 });
zip.file(p, xml);
const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
fs.writeFileSync(dst, out);

// checks: every other part identical, the tab reads back as wanted
const a = await JSZip.loadAsync(raw), b = await JSZip.loadAsync(out);
const diff = []; for (const n of Object.keys(a.files)) if (!a.files[n].dir && (await a.file(n).async("string")) !== (await b.file(n)?.async("string"))) diff.push(n);
console.log("parts changed:", diff.join(", "));
const ws2 = (await loadWorkbook(out)).getWorksheet("Contact details");
let bad = 0; want.forEach((w, r) => w.forEach((v, i) => { if (text(ws2.getCell(r + 2, i + 1)).trim() !== v) bad++; }));
console.log("read-back mismatches:", bad);
console.log("header:", Array.from({ length: 11 }, (_, i) => text(ws2.getCell(1, i + 1))).join(" | "));
for (let r = 1; r <= want.length + 2; r++) console.log(r, Array.from({ length: 11 }, (_, i) => text(ws2.getCell(r, i + 1))).filter((x, i) => i < 3 || x).join(" | "));
