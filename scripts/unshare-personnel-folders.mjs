// One-off (Ronan, 16 Nov 2026: "their own personnel folder shouldn't be shared with them"). Lists every clerk's
// Personnel folder that is shared with that clerk's own address, and with --go takes that one share off. The folder,
// its files and every other share are left as they are.
import fs from "node:fs"; import { createClient } from "@supabase/supabase-js";
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GO = process.argv.includes("--go");
let { data: c } = await db.from("google_connection").select("access_token,access_expires_at").eq("id", 1).single();
if (!c.access_expires_at || Date.parse(c.access_expires_at) < Date.now() + 10 * 60_000) {
  await fetch("https://dashboard.beamore.co.uk/api/sync/report-check", { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
  ({ data: c } = await db.from("google_connection").select("access_token,access_expires_at").eq("id", 1).single());
}
const H = { Authorization: `Bearer ${c.access_token}` };
const { data: rows } = await db.from("clerk_compliance").select("clerk_id,documents_folder_id,clerks(name,email,personal_email)").not("documents_folder_id", "is", null);
let found = 0;
for (const r of rows) {
  const own = [r.clerks?.email, r.clerks?.personal_email].filter(Boolean).map((e) => e.toLowerCase());
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${r.documents_folder_id}/permissions?supportsAllDrives=true&fields=permissions(id,emailAddress,role,type)`, { headers: H });
  if (!res.ok) { console.log("can't read", r.clerks?.name, res.status); continue; }
  for (const p of (await res.json()).permissions ?? []) {
    if (p.type !== "user" || !own.includes((p.emailAddress ?? "").toLowerCase())) continue;
    found++;
    console.log(`${r.clerks.name}: shared with ${p.emailAddress} (${p.role})`);
    if (GO) {
      const d = await fetch(`https://www.googleapis.com/drive/v3/files/${r.documents_folder_id}/permissions/${p.id}?supportsAllDrives=true`, { method: "DELETE", headers: H });
      console.log("   ", d.ok ? "share taken off" : `failed ${d.status}`);
    }
  }
}
console.log(`${rows.length} Personnel folders checked, ${found} shared with their own clerk`);
