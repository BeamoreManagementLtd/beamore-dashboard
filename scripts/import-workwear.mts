// One-off (Ronan, 24 Nov 2026): brings the workwear catalogue and every order so far from the "Beamore Workwear Orders"
// sheet into the dashboard, so each clerk's history shows on their portal. Safe to run again (orders keyed on ref).
// npx tsx --conditions=react-server scripts/import-workwear.mts [--go]
import { readFileSync } from "fs"; import { createClient } from "@supabase/supabase-js";
for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, ""); }
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const GO = process.argv.includes("--go");
const SHEET = "1e7ylv1bWfZRIJHTvQepK7gZJm7gVQLQwn1HgOb5HrhQ";
const { driveClient } = await import("../src/lib/google");
const { loadWorkbook } = await import("../src/lib/sync/load-workbook.mjs") as { loadWorkbook: (b: Buffer) => Promise<any> };
const g = await driveClient(db as never);
const wb = await loadWorkbook(Buffer.from(await g.exportXlsx(SHEET)));
const val = (v: any): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return v.richText ? v.richText.map((t: any) => t.text).join("") : v.text ?? v.hyperlink ?? (v.result != null ? String(v.result) : "");
  return String(v);
};
const rowsOf = (name: string) => {
  const ws = wb.getWorksheet(name); if (!ws) throw new Error(`No sheet ${name}`);
  const head: string[] = []; const out: Record<string, string>[] = [];
  ws.eachRow((row: any, n: number) => {
    const cells = (row.values as any[]).slice(1).map(val);
    if (n === 1) { head.push(...cells.map((c) => c.trim())); return; }
    if (!cells.some((c) => c.trim())) return;
    out.push(Object.fromEntries(head.map((h, k) => [h, (cells[k] ?? "").trim()])));
  });
  return out;
};
const allowed = rowsOf("Allowed Items"), variants = rowsOf("Item Variants"), lines = rowsOf("Supplier Orders");
console.log("items", allowed.length, "variants", variants.length, "order lines", lines.length);

// ---- catalogue
const typeOf = (id: string) => allowed.find((a) => a["Item ID"] === id)?.Type ?? "";
const items = allowed.map((a, k) => ({ id: a["Item ID"], type: a.Type, name: a["Item name"], supplier_code: a["Supplier code"] || null, image_url: a["Image URL"] || null, active: /^y/i.test(a.Active), sort: k }));
// items ordered on the old form but not on the allowed list now (e.g. the Dover jacket): kept, switched off
for (const l of lines) {
  const code = l["Supplier code"]; const id = code.slice(0, 5).toLowerCase();
  if (code && !items.some((i) => i.id === id) && variants.some((v) => v["Item ID"] === id)) items.push({ id, type: /hi-?vis.*(jacket|parka)/i.test(l.Item) ? "hivis" : "outerwear", name: l.Item, supplier_code: code.slice(0, 5), image_url: variants.find((v) => v["Item ID"] === id)?.["Image URL"] || null, active: false, sort: 100 + items.length });
}
const vars = variants.filter((v) => items.some((i) => i.id === v["Item ID"])).map((v, k) => ({ item_id: v["Item ID"], colour: v.Colour, size: v.Size, supplier_code: v["Supplier code"] || null, image_url: v["Image URL"] || null, active: /^y/i.test(v.Active), sort: k }));
// one row per item/colour/size
const seen = new Set<string>(); const uniqueVars = vars.filter((v) => { const k = `${v.item_id}|${v.colour}|${v.size}`; if (seen.has(k)) return false; seen.add(k); return true; });
console.log("catalogue:", items.map((i) => `${i.id}${i.active ? "" : " (off)"}`).join(", "), "|", uniqueVars.length, "variants");

// ---- orders: grouped by the old form's submission reference, else person + day
const { data: clerks } = await db.from("clerks").select("id,name,email");
const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const clerkFor = (l: Record<string, string>) => {
  const emails = [l["Verified Beamore email"], l.Contact].map((e) => e.toLowerCase()).filter((e) => e.includes("@"));
  return clerks!.find((c) => emails.includes((c.email ?? "").toLowerCase()))
    ?? clerks!.find((c) => norm(c.name) === norm(l["Staff member"]))
    ?? clerks!.find((c) => norm(c.name.split(" ").pop() ?? "") === norm(l["Staff member"].split(" ").pop() ?? "") && norm(c.name)[0] === norm(l["Staff member"])[0]) ?? null;
};
const dayOf = (s: string) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s); if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${(m[4] ?? "12").padStart(2, "0")}:${m[5] ?? "00"}:00Z`; const d = new Date(s); return isNaN(+d) ? new Date().toISOString() : d.toISOString(); };
const groups = new Map<string, Record<string, string>[]>();
for (const l of lines) {
  if (!l.Item && !l["Supplier code"]) continue;
  const key = l["Submission reference"] || `${norm(l["Staff member"])}|${dayOf(l.Submitted).slice(0, 10)}`;
  groups.set(key, [...(groups.get(key) ?? []), l]);
}
const orders = [...groups].map(([ref, ls]) => {
  const f = ls[0]; const c = clerkFor(f);
  return {
    order: { clerk_id: c?.id ?? null, name: f["Staff member"], contact: f.Contact || null, address: f["Delivery address"] || null, days_per_week: Number(f["Days worked"]) || null, notes: null, status: "ordered", source: "old_form", ref: `old:${ref}`, created_at: dayOf(f.Submitted), ordered_at: dayOf(f.Submitted) },
    lines: ls.map((l) => ({ item_id: (l["Supplier code"] || "").slice(0, 5).toLowerCase() || null, item_name: l.Item, supplier_code: l["Supplier code"] || null, colour: l.Colour || null, size: l.Size || null, quantity: Number(l.Quantity) || 1, link: l["Request link"] || null, notes: l.Notes || null })),
    who: c?.name ?? null,
  };
});
console.log("orders:", orders.length, "| not matched to a clerk:", orders.filter((o) => !o.who).map((o) => o.order.name).join(", ") || "none");
void typeOf;
if (!GO) process.exit(0);

const r1 = await db.from("workwear_items").upsert(items); if (r1.error) throw r1.error;
for (let k = 0; k < uniqueVars.length; k += 200) { const r = await db.from("workwear_variants").upsert(uniqueVars.slice(k, k + 200)); if (r.error) throw r.error; }
let added = 0;
for (const o of orders) {
  const { data: have } = await db.from("workwear_orders").select("id").eq("ref", o.order.ref).maybeSingle();
  if (have) continue;
  const { data: ins, error } = await db.from("workwear_orders").insert(o.order).select("id").single(); if (error) throw error;
  const r = await db.from("workwear_order_lines").insert(o.lines.map((l) => ({ ...l, order_id: ins!.id }))); if (r.error) throw r.error;
  added++;
}
console.log("imported", items.length, "items,", uniqueVars.length, "variants,", added, "orders");
