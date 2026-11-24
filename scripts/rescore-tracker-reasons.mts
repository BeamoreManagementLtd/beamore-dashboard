// One-off (Ronan, 24 Nov 2026): closed tracker items whose comment says "attended to", "dealt with", "sorted"... now
// count as saying why. Re-reads each affected report's tracker and re-marks that part (no AI). [--go]
import { readFileSync } from "fs"; import { createClient } from "@supabase/supabase-js";
import { scoreTotal } from "../src/lib/reports/score.ts";
for (const l of readFileSync(".env.local","utf8").split(/\r?\n/)) { const m=/^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]]=m[2].replace(/^"|"$/g,""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const GO = process.argv.includes("--go");
const { driveClient } = await import("../src/lib/google");
const d: any = await import("../src/lib/reports/docx.mjs");
const g = await driveClient(db as any);
const { data } = await db.from("reports").select("id,file_name,score,drive_file_id,checked_file_id,original_revision_id,fixes").eq("fixes->>score_by", "parts");
let changed = 0;
for (const r of data!) {
  const parts = r.fixes.score_parts ?? [];
  const k = parts.findIndex((p: any) => p.label === "Issues tracker and file name");
  if (k < 0 || !/doesn't say why/.test(parts[k].improve ?? "")) continue;
  let buf: Buffer;
  try { buf = Buffer.from(r.original_revision_id ? await g.downloadRevision(r.drive_file_id, r.original_revision_id).catch(() => g.download(r.drive_file_id)) : await g.download(r.drive_file_id)); } catch { console.log("can't read", r.file_name); continue; }
  const t = d.issuesTracker(await d.readReport(buf));
  const p = parts[k];
  const nums = (a: string[]) => `${a.slice(0, 8).join(", ")}${a.length > 8 ? ` and ${a.length - 8} more` : ""}`;
  const u = t.closedReasonUnclear as string[];
  if (u.length) {
    // still some: the same marks, but the feedback lists only the ones that really don't say why
    const tip = `item${u.length === 1 ? "" : "s"} ${nums(u)} closed, but the comment doesn't say why (e.g. item ${t.unclearExamples[0].no}: "${t.unclearExamples[0].comment}")`;
    const improve = (p.improve as string).split("; ").map((x: string) => (/doesn't say why/.test(x) ? tip : x)).join("; ");
    if (improve === p.improve) continue;
    const np = parts.map((x: any, j: number) => (j === k ? { ...p, improve } : x));
    changed++; console.log(`(wording only) ${r.file_name}: ${u.length} items still unclear`);
    if (GO) await db.from("reports").update({ fixes: { ...r.fixes, score_parts: np } }).eq("id", r.id);
    continue;
  }
  const tips = (p.improve as string).split("; ").filter((x: string) => !/doesn't say why/.test(x));
  const kinds = Number(/(\d+) kinds? of tracker problem/.exec(p.note)?.[1] ?? 0);
  const left = Math.max(0, kinds - 1);
  const q = { ...p, got: Math.min(10, Math.round((p.got + 2) * 10) / 10), note: p.note.replace(/\d+ kinds? of tracker problem/, left ? `${left} kind${left === 1 ? "" : "s"} of tracker problem` : "tracker done right"), improve: tips.length ? tips.join("; ") : undefined };
  if (!q.improve) delete q.improve;
  const np = parts.map((x: any, j: number) => (j === k ? q : x));
  const score = scoreTotal(np);
  changed++;
  console.log(`${r.score} -> ${score}  ${r.file_name}`);
  if (GO) await db.from("reports").update({ score, fixes: { ...r.fixes, score_parts: np } }).eq("id", r.id);
}
console.log(GO ? "updated" : "dry run", changed);
