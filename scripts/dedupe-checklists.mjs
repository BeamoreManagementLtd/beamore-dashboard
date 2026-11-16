// One-off (16 Nov 2026): the hourly scan re-added some projects' checklists (it only read 1,000 rows). For each
// project + item, keep the row with the most progress (received, requested, note; then the oldest) and remove the
// other copies, plus the repeated "Checklist started" log lines (keeps the first). Dry run unless --go.
import fs from "node:fs"; import { createClient } from "@supabase/supabase-js";
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const go = process.argv.includes("--go");
const all = async (t, cols) => { const out = []; for (let f = 0; ; f += 1000) { const { data, error } = await db.from(t).select(cols).order("id").range(f, f + 999); if (error) throw error; out.push(...data); if (data.length < 1000) return out; } };
const rows = await all("project_info", "*");
const groups = new Map(); for (const r of rows) { const k = `${r.project_id}|${r.item}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
const rank = (r) => (r.received_on ? 4 : 0) + (r.requested_on ? 2 : 0) + (r.note ? 1 : 0);
const drop = []; let groupsHit = 0, lost = 0;
for (const g of groups.values()) {
  if (g.length < 2) continue; groupsHit++;
  g.sort((a, b) => rank(b) - rank(a) || a.created_at.localeCompare(b.created_at));
  for (const x of g.slice(1)) { drop.push(x.id); if (rank(x) > 0 && (x.received_on !== g[0].received_on || x.requested_on !== g[0].requested_on || (x.note && x.note !== g[0].note))) lost++; }
}
const ev = await all("project_events", "id,project_id,happened_at,kind");
const byP = new Map(); for (const e of ev.filter((e) => e.kind === "Checklist started")) byP.set(e.project_id, [...(byP.get(e.project_id) ?? []), e]);
const dropEv = []; for (const l of byP.values()) { l.sort((a, b) => a.happened_at.localeCompare(b.happened_at)); dropEv.push(...l.slice(1).map((e) => e.id)); }
console.log({ duplicateGroups: groupsHit, rowsToRemove: drop.length, copiesWithDifferentProgress: lost, repeatedLogLines: dropEv.length });
if (go) {
  for (let i = 0; i < drop.length; i += 100) { const { error } = await db.from("project_info").delete().in("id", drop.slice(i, i + 100)); if (error) throw error; }
  for (let i = 0; i < dropEv.length; i += 100) { const { error } = await db.from("project_events").delete().in("id", dropEv.slice(i, i + 100)); if (error) throw error; }
  console.log("removed");
}
