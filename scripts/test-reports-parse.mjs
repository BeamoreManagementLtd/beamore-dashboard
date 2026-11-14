// node scripts/test-reports-parse.mjs "<turnaround.xlsx>"
import fs from "node:fs";
import { loadWorkbook } from "../src/lib/sync/load-workbook.mjs";
import { parseLog } from "../src/lib/sync/reports-parse.mjs";
const wb = await loadWorkbook(fs.readFileSync(process.argv[2]));
const log = parseLog(wb);
console.log("log rows", log.length, log[0], log.at(-1));
const by = {}; for (const l of log) by[l.status] = (by[l.status] ?? 0) + 1; console.log(by);
console.log("no report date:", log.filter((l) => !l.report_date).length, "| no working days:", log.filter((l) => l.working_days == null).length);
