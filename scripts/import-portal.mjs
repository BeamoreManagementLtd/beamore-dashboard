// Imports the old Google portal's private register into the dashboard. Safe to run again: everything is upserted.
//   node scripts/import-portal.mjs            (dry run: prints what it would do)
//   node scripts/import-portal.mjs --write
// Step 1 copies every row of every tab verbatim into portal_legacy_rows. Step 2 maps them into the portal tables.
import fs from "node:fs";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";
import { mapLegacy } from "./portal-legacy-map.mjs";

const REGISTER = "1oyNGv4oJTbKxUFC8FIKjJWZZo2x4vs4SuMTX7QHh0UY";
const write = process.argv.includes("--write");
const env = Object.fromEntries(fs.readFileSync(".env.local", "utf8").split(/\r?\n/).filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function googleToken() {
  const { data: c } = await db.from("google_connection").select("*").eq("id", 1).single();
  if (c.access_token && new Date(c.access_expires_at) > new Date()) return c.access_token;
  const t = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: c.refresh_token, grant_type: "refresh_token" }) })).json();
  if (!t.access_token) throw new Error("Google token: " + t.error);
  return t.access_token;
}

const cell = (v) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return v.text ?? v.result ?? (v.richText ? v.richText.map((r) => r.text).join("") : JSON.stringify(v));
  return v;
};

const token = await googleToken();
const res = await fetch(`https://www.googleapis.com/drive/v3/files/${REGISTER}/export?mimeType=${encodeURIComponent("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}`, { headers: { Authorization: `Bearer ${token}` } });
if (!res.ok) throw new Error(`Register download failed: ${res.status}`);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));

const sheets = {};
const legacy = [];
for (const ws of wb.worksheets) {
  const hdr = (ws.getRow(1).values || []).slice(1).map((v) => String(cell(v) ?? "").trim());
  const rows = [];
  ws.eachRow((r, i) => {
    if (i === 1) return;
    const vals = hdr.map((_, k) => cell(r.getCell(k + 1).value));
    if (!vals.some((v) => v !== null && v !== "")) return;
    const o = Object.fromEntries(hdr.map((h, k) => [h, vals[k]]));
    rows.push(o);
    legacy.push({ sheet: ws.name, row_number: i, data: o });
  });
  sheets[ws.name] = rows;
  console.log(`${ws.name}: ${rows.length} rows`);
}

if (write) {
  for (let i = 0; i < legacy.length; i += 200) {
    const { error } = await db.from("portal_legacy_rows").upsert(legacy.slice(i, i + 200));
    if (error) throw new Error("legacy rows: " + error.message);
  }
  console.log(`saved ${legacy.length} verbatim rows`);
}
await mapLegacy(db, sheets, { write });
