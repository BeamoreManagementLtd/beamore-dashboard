// Loads local copies of the report files (same code as the Drive sync):
//   node --env-file=.env.local scripts/load-reports.mjs "<Report Turnaround Dashboard.xlsx>" ["<Ready To Check export.xlsx>"]
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadWorkbook } from "../src/lib/sync/load-workbook.mjs";
import { parseQueue, parseLog } from "../src/lib/sync/reports-parse.mjs";
import { writeQueue, writeLog } from "../src/lib/sync/reports-write.mjs";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const [logFile, queueFile] = process.argv.slice(2);
console.log(await writeLog(admin, parseLog(await loadWorkbook(fs.readFileSync(logFile)))));
if (queueFile) console.log(await writeQueue(admin, parseQueue(await loadWorkbook(fs.readFileSync(queueFile))), new Date().toISOString()));
