// One-off (Ronan, 20 Nov 2026): H&S items re-marked on the new rules, from what each report's check recorded (no
// re-check, no AI): "N/A" counts in full, and weekly CQM site inspection reports are marked on all 10 items.
// npx tsx scripts/rescore-hs.mts [--go]
import { readFileSync } from "fs"; import { createClient } from "@supabase/supabase-js";
import { scoreTotal } from "../src/lib/reports/score.ts";
for (const l of readFileSync(".env.local","utf8").split(/\r?\n/)) { const m=/^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]]=m[2].replace(/^"|"$/g,""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const GO = process.argv.includes("--go");
const r1 = (n: number) => Math.round(Math.max(0, n) * 10) / 10;
const list = (a: string[]) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const all: any[] = [];
for (let f = 0; ; f += 500) { const { data } = await db.from("reports").select("id,file_name,folder_name,score,report_number,text_snapshot,fixes").eq("fixes->>score_by", "parts").order("id").range(f, f + 499); all.push(...data!); if (data!.length < 500) break; }
let changed = 0, cqmNow = 0;
for (const r of all) {
  const parts = r.fixes.score_parts ?? [];
  const k = parts.findIndex((p: any) => p.label === "Health and safety items");
  const hs = r.fixes.health_safety as { label: string; status: string }[] | null;
  if (k < 0 || !Array.isArray(hs) || !hs.length) continue;
  const p = parts[k];
  const notJudged = /not judged/.test(p.note);
  if (notJudged) {
    // only the weekly CQM forms are newly judged: not monthly reports, not a job's first two, not ones with an appendix
    const top = (r.text_snapshot ?? "").slice(0, 3000);
    const cqm = /CQM|Construction Quality\s+Monitoring/i.test(top);
    const monthly = /monthly/i.test(`${r.file_name} ${r.folder_name ?? ""}`) || /Monthly Report/i.test(top.split(/Refer to the guidance/i)[0].slice(0, 200));
    const n0 = Number(/\d+/.exec(r.report_number ?? "")?.[0] ?? 99);
    if (!cqm || monthly || n0 <= 2 || r.fixes.appendix) continue;
    cqmNow++;
  }
  const n = hs.length || 10, ok = hs.filter((h) => h.status === "ok").length, thin = hs.filter((h) => h.status === "thin").length;
  const gone = hs.filter((h) => h.status === "missing"), empty = hs.filter((h) => h.status === "empty");
  const why = [gone.length ? `${list(gone.map((h) => h.label))} taken out` : "", empty.length ? `${list(empty.map((h) => h.label))} left empty` : ""].filter(Boolean);
  const q: any = { label: p.label, of: 10, got: r1(((ok + thin) / n) * 10), note: `${ok + thin} of ${n} filled in${thin ? ` (${thin} "N/A", which is fine)` : ""}` };
  if (why.length) q.improve = `${why.join("; ")}. Fill in all ${n} at the start of every report ("N/A" is fine where nothing of that kind is happening)`;
  const np = parts.map((x: any, j: number) => (j === k ? q : x));
  const score = scoreTotal(np);
  if (score === r.score && JSON.stringify(q) === JSON.stringify(p)) continue;
  changed++;
  if (/Woodside|THURSTON|Sandbach/i.test(r.file_name)) console.log(`${r.score} -> ${score}  ${r.file_name}  [${q.note}]`);
  if (GO) await db.from("reports").update({ score, fixes: { ...r.fixes, score_parts: np } }).eq("id", r.id);
}
console.log(GO ? "updated" : "dry run", changed, "of", all.length, "| CQM newly judged:", cqmNow);
