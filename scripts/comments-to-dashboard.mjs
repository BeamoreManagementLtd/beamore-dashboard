// One-off (Ronan, 16 Nov 2026): the AI's points are now listed on the dashboard with page numbers, not as comments in
// the Word file. For every checked report waiting to be sent: the dashboard's own comments come out of the clerk's
// file (tracked spelling changes and anyone else's comments stay), each point gets a few words from where it is, and
// the report is queued for the office PC's Word helper to look up page numbers.
// node scripts/comments-to-dashboard.mjs [--go]
import fs from "node:fs"; import { createClient } from "@supabase/supabase-js";
import { readReport, nearText, withoutOwnMarks } from "../src/lib/reports/docx.mjs";
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GO = process.argv.includes("--go");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let { data: c } = await db.from("google_connection").select("access_token,access_expires_at").eq("id", 1).single();
if (Date.parse(c.access_expires_at) < Date.now() + 20 * 60_000) {
  await fetch("https://dashboard.beamore.co.uk/api/sync/report-check", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  ({ data: c } = await db.from("google_connection").select("access_token,access_expires_at").eq("id", 1).single());
}
const H = { Authorization: `Bearer ${c.access_token}` };
const api = "https://www.googleapis.com/drive/v3/files";

const { data: reps } = await db.from("reports").select("id,file_name,drive_file_id,checked_file_id,checked_revision,checked_at,issues,fixes").eq("status", "ready");
let done = 0;
for (const r of reps.filter((x) => x.checked_file_id === x.drive_file_id)) {
  try {
    const meta = await (await fetch(`${api}/${r.drive_file_id}?fields=headRevisionId&supportsAllDrives=true`, { headers: H })).json();
    const buf = Buffer.from(await (await fetch(`${api}/${r.drive_file_id}?alt=media&supportsAllDrives=true`, { headers: H })).arrayBuffer());
    const before = (await readReport(buf));
    const comments = ((await before.zip.file("word/comments.xml")?.async("string")) ?? "").split('w:author="Beamore AI check"').length - 1;
    const issues = (r.issues ?? []).map((i) => ({ ...i, near: nearText(before, i.p), page: null }));
    console.log(`${String(comments).padStart(3)} comments, ${issues.filter((i) => i.near).length}/${issues.length} points placed  ${r.file_name}`);
    if (!GO) continue;
    if (comments) {
      const out = await withoutOwnMarks(buf, { keepChanges: true });
      const up = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${r.drive_file_id}?uploadType=media&supportsAllDrives=true`, { method: "PATCH", headers: { ...H, "Content-Type": DOCX }, body: out });
      if (!up.ok) throw new Error(`upload ${up.status}`);
    }
    const after = await (await fetch(`${api}/${r.drive_file_id}?fields=headRevisionId&supportsAllDrives=true`, { headers: H })).json();
    // if nobody had changed it since the check, it still counts as untouched (so Check again starts from the clerk's version)
    const untouched = meta.headRevisionId === r.checked_revision;
    await db.from("reports").update({
      issues, fixes: { ...(r.fixes ?? {}), pages_state: issues.some((i) => i.near) ? "waiting" : "none", pages_tries: 0 },
      ...(untouched ? { checked_revision: after.headRevisionId } : {}),
    }).eq("id", r.id).eq("checked_at", r.checked_at);
    done++;
  } catch (e) { console.log(`ERROR ${r.file_name}: ${e.message}`); }
}
console.log(GO ? `${done} reports done` : "(dry run)");
