// Checks the diary parser against a local copy of the diary:  node scripts/test-diary-parse.mjs "<path to Diary 2026.xlsx>"
import ExcelJS from "exceljs";
import { parseDiary } from "../src/lib/sync/diary-parse.mjs";

const wb = new ExcelJS.Workbook();
const t0 = Date.now();
await wb.xlsx.readFile(process.argv[2]);
const t1 = Date.now();
const d = parseDiary(wb);
console.log(`load ${t1 - t0}ms, parse ${Date.now() - t1}ms`);
const by = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
console.log("visits by month/side:", by(d.visits, (v) => v.date.slice(0, 7) + " " + v.side));
console.log("clerks:", d.clerks.length, "| absences:", d.absences.length, "| invoice lines:", d.invoiceLines.length, "| rates:", d.rates.length);
// October check against the reconciliation: Houghal = 12 days charged and 12 invoiced
const oct = d.visits.filter((v) => v.date.startsWith("2026-10") && v.side === "charged" && /houghal/i.test(v.site));
console.log("Houghal Oct charged days:", oct.length / 2, "| invoiced:", d.invoiceLines.filter((i) => i.month === "October" && /houghal/i.test(i.site)).reduce((s, i) => s + i.days, 0));
console.log("sample weekend:", d.visits.find((v) => new Date(v.date).getUTCDay() === 6));
console.log("sample absence:", d.absences[0], "| sample Nov planned:", d.visits.filter((v) => v.side === "planned").slice(0, 2));
