// One-off (Ronan, 16 Nov 2026: scoring "a little bit harsh in areas"): re-marks reports already scored with the 7
// parts using the softer spelling, progress, best-practice and photo rules, from what each part already recorded. No
// re-check, no AI. node scripts/rescore-softer.mjs [--go]
import fs from "node:fs"; import { createClient } from "@supabase/supabase-js";
import { spellingMark, programmeMark, standardsMark, photoShapeMark, scoreTotal } from "../src/lib/reports/score.ts";
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GO = process.argv.includes("--go");
const num = (s, re) => Number((re.exec(s ?? "")?.[1] ?? "0").replace(/,/g, ""));
const r1 = (n) => Math.round(Math.max(0, n) * 10) / 10;

const { data } = await db.from("reports").select("id,file_name,score,fixes").eq("fixes->>score_by", "parts");
let changed = 0;
for (const r of data) {
  const parts = (r.fixes.score_parts ?? []).map((p) => {
    const q = { ...p };
    if (p.label === "Spelling and grammar") {
      q.got = spellingMark(num(p.note, /^(\d+) mistake/), num(p.note, /about ([\d,]+) words/));
      if (q.got >= 10) delete q.improve;
    } else if (/^Progress/.test(p.label) && /short of the method/.test(p.note)) {
      q.got = programmeMark("weak", num(p.note, /^(\d+) thing/));
    } else if (p.label === "Best practices" && /^\d+ of \d+$/.test(p.note)) {
      q.got = standardsMark(num(p.note, /^(\d+) of/), num(p.note, /of (\d+)$/));
      if (q.got >= 10) delete q.improve;
    } else if (p.label === "Photos") {
      const st = num(p.note, /(\d+) stretched/), sw = num(p.note, /(\d+) sideways/);
      if (sw) {
        q.got = r1(Math.min(10, p.got + photoShapeMark(st) - Math.max(0, 2 - 0.5 * (st + sw))));
        q.note = p.note.replace(/(\d+) sideways/, "$1 may be sideways (not marked down)");
        q.improve = (p.improve ?? "").split(". ").filter((t) => !/right way up/.test(t)).join(". ") || undefined;
      }
    }
    return q;
  });
  const score = scoreTotal(parts);
  if (score === r.score && JSON.stringify(parts) === JSON.stringify(r.fixes.score_parts)) continue;
  changed++;
  if (/Skelton|Forum/.test(r.file_name)) console.log(`${r.score} -> ${score}  ${r.file_name}\n   ${parts.map((p) => `${p.label} ${p.got}`).join(" | ")}`);
  if (GO) await db.from("reports").update({ score, fixes: { ...r.fixes, score_parts: parts } }).eq("id", r.id);
}
const before = data.map((r) => r.score).sort((a, b) => a - b);
console.log(`${changed} of ${data.length} reports ${GO ? "re-scored" : "would change"}; median before ${before[Math.floor(before.length / 2)]}`);
