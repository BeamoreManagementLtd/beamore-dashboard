// One-off (Ronan, 16 Nov 2026): reports are now checked in the clerk's own file, so the checks already made in
// "Checked (dashboard)" copies are moved onto the clerks' files, and the copies binned.
//  - a good copy: the clerk's uploaded version is kept for good in Drive's history, the copy's content is saved over
//    the clerk's file (renamed to the copy's name), and the copy goes in the bin
//  - a copy Word can't open (the comment fault fixed today), or a clerk's file changed since it was checked: the
//    report is queued to be checked again, which now works in the clerk's file and bins the old copy itself
//  - reports already approved or sent are left as they are
// Then any "Checked (dashboard)" folder left empty is put in the bin.
// node scripts/move-checks-in-place.mjs          (says what it would do)
// node scripts/move-checks-in-place.mjs --go     (does it)
// node scripts/move-checks-in-place.mjs --folders --go   (only bins the empty folders, e.g. after the re-checks)
import fs from "node:fs"; import { createClient } from "@supabase/supabase-js"; import JSZip from "jszip"; import { SaxesParser } from "saxes";
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GO = process.argv.includes("--go"), FOLDERS_ONLY = process.argv.includes("--folders");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// the live dashboard's Drive connection (its 15-minute jobs keep the access token fresh); run the scan first if stale
let { data: c } = await db.from("google_connection").select("access_token,access_expires_at").eq("id", 1).single();
if (!c.access_expires_at || Date.parse(c.access_expires_at) < Date.now() + 10 * 60_000) {
  await fetch("https://dashboard.beamore.co.uk/api/sync/report-check", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  ({ data: c } = await db.from("google_connection").select("access_token,access_expires_at").eq("id", 1).single());
}
const H = { Authorization: `Bearer ${c.access_token}` };
const api = "https://www.googleapis.com/drive/v3";
const ask = async (url, init = {}) => { const r = await fetch(url, { ...init, headers: { ...H, ...(init.headers ?? {}) } }); if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`); return r; };
const meta = (id) => ask(`${api}/files/${id}?fields=id,name,headRevisionId,modifiedTime,trashed&supportsAllDrives=true`).then((r) => r.json());
const patch = (id, body) => ask(`${api}/files/${id}?supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function opens(buf) {
  const zip = await JSZip.loadAsync(buf);
  for (const n of Object.keys(zip.files).filter((n) => /\.(xml|rels)$/.test(n))) {
    const p = new SaxesParser(); let bad = null; p.on("error", (e) => { bad ??= e; });
    try { p.write(await zip.file(n).async("string")).close(); } catch (e) { bad ??= e; }
    if (bad) return false;
  }
  return true;
}

const tally = { moved: 0, recheck: 0, skipped: 0 };
if (!FOLDERS_ONLY) {
  const { data: reps } = await db.from("reports").select("id,status,drive_file_id,file_name,folder_id,checked_file_id,checked_name,checked_at,renamed_from").not("checked_file_id", "is", null);
  for (const r of reps.filter((x) => x.checked_file_id !== x.drive_file_id)) {
    const label = `${r.status.padEnd(8)} ${r.checked_name ?? r.file_name}`;
    if (!["ready", "failed", "new", "checking"].includes(r.status)) { console.log(`leave    ${label} (already ${r.status})`); tally.skipped++; continue; }
    try {
      const orig = await meta(r.drive_file_id);
      if (orig.trashed) { console.log(`skip     ${label}: the clerk's file is in the bin`); tally.skipped++; continue; }
      const copy = Buffer.from(await (await ask(`${api}/files/${r.checked_file_id}?alt=media&supportsAllDrives=true`)).arrayBuffer());
      const changed = r.checked_at && Date.parse(orig.modifiedTime) > Date.parse(r.checked_at) + 5 * 60_000;
      const good = await opens(copy);
      if (!good || changed) {
        console.log(`recheck  ${label}: ${!good ? "the copy won't open in Word" : "the clerk changed their file after it was checked"}`);
        if (GO) await db.from("reports").update({ status: "new", error: null }).eq("id", r.id);
        tally.recheck++; continue;
      }
      console.log(`move     ${label}`);
      if (GO) {
        await patch(`${r.drive_file_id}/revisions/${orig.headRevisionId}`, { keepForever: true });
        await ask(`https://www.googleapis.com/upload/drive/v3/files/${r.drive_file_id}?uploadType=media&supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": DOCX }, body: copy });
        const name = r.checked_name ?? r.file_name;
        if (name !== orig.name) await patch(r.drive_file_id, { name });
        const after = await meta(r.drive_file_id);
        const now = new Date().toISOString();
        await db.from("reports").update({
          checked_file_id: r.drive_file_id, checked_folder_id: r.folder_id, file_name: name, checked_name: name,
          renamed_from: name !== orig.name ? orig.name : r.renamed_from, original_revision_id: orig.headRevisionId,
          checked_revision: after.headRevisionId, checked_at: now, modified_at: now,
        }).eq("id", r.id);
        await patch(r.checked_file_id, { trashed: true });
      }
      tally.moved++;
    } catch (e) { console.log(`ERROR    ${label}: ${e.message}`); tally.skipped++; }
  }
}

// "Checked (dashboard)" folders with nothing left in them
const q = encodeURIComponent(`name = 'Checked (dashboard)' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
const folders = (await (await ask(`${api}/files?q=${q}&fields=files(id)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json()).files;
let binned = 0, kept = 0;
for (const f of folders) {
  const inside = (await (await ask(`${api}/files?q=${encodeURIComponent(`'${f.id}' in parents and trashed = false`)}&fields=files(id)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`)).json()).files;
  if (inside.length) { kept++; continue; }
  if (GO) await patch(f.id, { trashed: true });
  binned++;
}
console.log(JSON.stringify({ ...tally, emptyFoldersBinned: binned, foldersStillInUse: kept, dryRun: !GO }));
