import fs from "node:fs"; import { createClient } from "@supabase/supabase-js";
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data: g } = await db.from("google_connection").select("access_token,diary_files,diary_file_id").limit(1).single();
const id = g.diary_files?.["2026"] ?? g.diary_file_id; const H = { headers: { Authorization: `Bearer ${g.access_token}` } };
const meta = await (await fetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=headRevisionId,modifiedTime`, H)).json();
fs.writeFileSync(process.argv[2], Buffer.from(await (await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, H)).arrayBuffer()));
console.log("saved", process.argv[2], JSON.stringify(meta));
