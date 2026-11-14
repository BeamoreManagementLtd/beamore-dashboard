// One-off fix (14 Nov 2026): adds projects that are in the diary/Xero but not in the Cost Proposals register,
// records each project's diary spellings (diary_aliases), marks projects with October/November visits as live,
// and links invoices to projects. Safe to re-run.
//   node --env-file=.env.local scripts/apply-project-plan.mjs data/private/project_plan.json
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { siteKey } from "../src/lib/site-key.mjs";

const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

let projects = must(await db.from("projects").select("id,number,name,stage,diary_aliases"), "read projects");
const byNum = new Map(projects.map((p) => [p.number, p]));

// 1. diary spellings + live stage for register projects
let aliased = 0, madeLive = 0;
for (const [num, aliases] of Object.entries(plan.aliases)) {
  const p = byNum.get(Number(num));
  if (!p) continue;
  const merged = [...new Set([...p.diary_aliases, ...aliases])];
  const patch = {};
  if (merged.length !== p.diary_aliases.length) { patch.diary_aliases = merged; aliased++; }
  if (plan.make_live.includes(Number(num)) && p.stage !== "live") { patch.stage = "live"; madeLive++; }
  if (Object.keys(patch).length) must(await db.from("projects").update(patch).eq("id", p.id), `update ${num}`);
}

// 2. new projects (numbers continue after the register's last number)
let next = Math.max(...projects.map((p) => p.number)) + 1, created = 0;
for (const n of plan.new) {
  const same = projects.find((p) => p.name === n.name);
  if (same) { // the register has it under the full name (diary says "NewKentRd"): add the spellings, don't duplicate
    const merged = [...new Set([...same.diary_aliases, ...n.aliases])];
    const patch = { diary_aliases: merged, ...(n.live && same.stage !== "live" ? { stage: "live" } : {}) };
    if (merged.length !== same.diary_aliases.length || patch.stage) must(await db.from("projects").update(patch).eq("id", same.id), `merge ${n.name}`);
    continue;
  }
  must(await db.from("projects").insert({
    number: next++, name: n.name, stage: n.live ? "live" : "complete", diary_aliases: n.aliases, extraction_confidence: "Diary",
  }), `insert ${n.name}`);
  created++;
}

// 3. link invoices to projects: the diary's invoice table first, then the Xero reference ("Foxwood - August 2026")
projects = must(await db.from("projects").select("id,number,diary_aliases"), "re-read projects");
const byKey = new Map();
for (const p of projects) for (const a of p.diary_aliases) byKey.set(siteKey(a), p.id);
const invoices = must(await db.from("invoices").select("id,number,reference,project_id,client_id"), "read invoices");
let linked = 0;
for (const i of invoices) {
  const site = plan.inv_site[i.number];
  const pid = (site && byKey.get(siteKey(site))) || (i.reference && byKey.get(siteKey(i.reference.split(/\s+-\s+/)[0])));
  if (pid && pid !== i.project_id) { must(await db.from("invoices").update({ project_id: pid }).eq("id", i.id), `link ${i.number}`); linked++; }
  if (pid && i.client_id) await db.from("projects").update({ client_id: i.client_id }).eq("id", pid).is("client_id", null);
}
console.log(`Diary spellings added to ${aliased} projects, ${madeLive} set live, ${created} new projects, ${linked} invoices linked.`);
