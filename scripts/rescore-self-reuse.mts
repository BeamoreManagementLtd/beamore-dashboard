// One-off (Ronan, 24 Nov 2026, Peter Restorick): reports and pre-checks marked down for photos "reused" from what was
// really the same report (80%+ of the photos matched) get the photo marks back. No AI. [--go]
import { readFileSync } from "fs"; import { createClient } from "@supabase/supabase-js";
import { scoreTotal } from "../src/lib/reports/score.ts";
for (const l of readFileSync(".env.local","utf8").split(/\r?\n/)) { const m=/^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]]=m[2].replace(/^"|"$/g,""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const GO = process.argv.includes("--go");
const r1 = (n: number) => Math.round(Math.max(0, n) * 10) / 10;
for (const table of ["reports", "report_prechecks"]) {
  const { data } = await db.from(table).select("id,file_name,score,fixes").eq("fixes->>score_by", "parts");
  const rows = table === "report_prechecks" ? (await db.from(table).select("id,file_name,score,fixes").not("fixes", "is", null)).data! : data!;
  for (const r of rows) {
    const parts = r.fixes?.score_parts ?? [];
    const k = parts.findIndex((p: any) => p.label === "Photos");
    if (k < 0) continue;
    const p = parts[k];
    const m = /^(\d+) photos? \((\d+) reused\)/.exec(p.note ?? "");
    if (!m) continue;
    const count = +m[1], reused = +m[2];
    if (reused / count < 0.8) continue;
    const exp = Number(/(\d+) or more/.exec(p.note)?.[1] ?? 0);
    const gain = exp ? (Math.min(1, count / exp) - Math.min(1, (count - reused) / exp)) * 4 : 0;
    const note = p.note.replace(/ \(\d+ reused\)/, "").replace(/short of the (\d+) or more aimed for/, (s: string) => (count >= exp ? `plenty (${exp} or more is the aim)` : s));
    const improve = (p.improve ?? "").split(". ").map((t: string) => /Take fresh photos each visit/.test(t) ? (count >= exp ? "" : `Aim for at least ${exp} photos covering the areas described`) : t).filter(Boolean).join(". ");
    const q: any = { ...p, got: r1(Math.min(10, p.got + gain)), note }; if (improve) q.improve = improve; else delete q.improve;
    const np = parts.map((x: any, j: number) => (j === k ? q : x));
    const score = scoreTotal(np);
    console.log(`${table}: ${r.score} -> ${score}  ${r.file_name}  (${count} photos, ${reused} "reused")`);
    if (GO) await db.from(table).update({ score, fixes: { ...r.fixes, score_parts: np } }).eq("id", r.id);
  }
}
