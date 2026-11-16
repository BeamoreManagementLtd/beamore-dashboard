// One-off (16 Nov 2026): reports whose comment markers point at comments that were taken out (a file re-saved in Word
// after the check, then the AI's comments removed; Word called it corrupted). Removes those markers, nothing else.
// node scripts/repair-orphan-comments.mjs [--go]
import fs from "node:fs"; import { createClient } from "@supabase/supabase-js";
import { readReport, dropOrphanComments, saveReport } from "../src/lib/reports/docx.mjs";
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GO = process.argv.includes("--go");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let { data: c } = await db.from("google_connection").select("access_token,access_expires_at").eq("id", 1).single();
if (Date.parse(c.access_expires_at) < Date.now() + 20 * 60_000) {
  await fetch("https://dashboard.beamore.co.uk/api/sync/report-check", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  ({ data: c } = await db.from("google_connection").select("access_token,access_expires_at").eq("id", 1).single());
}
const H = { Authorization: `Bearer ${c.access_token}` }, api = "https://www.googleapis.com/drive/v3/files";
const { data: reps } = await db.from("reports").select("id,file_name,drive_file_id,checked_file_id,checked_revision,fixes").in("status", ["ready", "approved"]);
let fixed = 0;
for (const r of reps.filter((x) => x.checked_file_id === x.drive_file_id)) {
  const meta = await (await fetch(`${api}/${r.drive_file_id}?fields=headRevisionId&supportsAllDrives=true`, { headers: H })).json();
  const doc = await readReport(Buffer.from(await (await fetch(`${api}/${r.drive_file_id}?alt=media&supportsAllDrives=true`, { headers: H })).arrayBuffer()));
  const cut = await dropOrphanComments(doc);
  if (!cut) continue;
  fixed++;
  console.log(`markers removed (${cut} chars): ${r.file_name}`);
  if (!GO) continue;
  const up = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${r.drive_file_id}?uploadType=media&supportsAllDrives=true`, { method: "PATCH", headers: { ...H, "Content-Type": DOCX }, body: await saveReport(doc) });
  if (!up.ok) { console.log("  upload failed", up.status); continue; }
  const after = await (await fetch(`${api}/${r.drive_file_id}?fields=headRevisionId&supportsAllDrives=true`, { headers: H })).json();
  await db.from("reports").update({
    fixes: { ...r.fixes, pages_state: r.fixes?.pages_state === "failed" ? "waiting" : r.fixes?.pages_state, pages_tries: 0 },
    ...(meta.headRevisionId === r.checked_revision ? { checked_revision: after.headRevisionId } : {}),
  }).eq("id", r.id);
}
console.log(`${fixed} report(s) ${GO ? "repaired" : "need repair"}`);
