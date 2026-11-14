// Checks the cost-sheet reader on real files from Drive (read only). Usage: node scripts/test-proposal-parse.mjs
import fs from "node:fs";
import { loadWorkbook } from "../src/lib/sync/load-workbook.mjs";
import { parseCostSheet } from "../src/lib/sync/proposal-parse.mjs";
const base = "G:/My Drive/Business/Beamore Management/Cost Proposals/";
for (const f of ["Motts/Appleby/Appleby Grammar School - TAS25 CQM Cost Schedule - From 22 June 2026.xlsx", "Gleeds/Pinn River School/Pinn River - Costs - Rev C.xlsx", "StockdaleUK/Treetops/Treetops -  Costs.xlsx", "Gleeds/Beacon College/Beacon costs.xlsx"]) {
  const rows = parseCostSheet(await loadWorkbook(fs.readFileSync(base + f)));
  const tb = rows.reduce((a, r) => a + r.building, 0), tm = rows.reduce((a, r) => a + r.me, 0);
  console.log(f.split("/").pop(), "→", rows.length, "months, building", tb, "M&E", tm, rows.slice(4, 7).map((r) => `${r.month.slice(0, 7)}:${r.building}/${r.me}`).join(" "));
}
