// One-off first load: puts the 14 Nov 2026 snapshot (register, overdue invoices + Gmail chase history,
// report queue, clerks, finance) into Supabase. Run once after the schema migration:
//   node --env-file=.env.local scripts/import-snapshot.mjs data/private/snapshot-2026-11-14.json
// Uses the service-role key, so run it only on your own computer. Safe to re-run: it upserts.
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const file = process.argv[2];
if (!file) throw new Error("Pass the snapshot file path");
const snap = JSON.parse(fs.readFileSync(file, "utf8"));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const must = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

const STAGE = {
  Live: "live", Pricing: "pricing", "Sent – awaiting reply": "sent", Lost: "lost", Complete: "complete",
  "On hold": "on_hold", "Check status": "enquiry", Enquiry: "enquiry",
  "Won – arranging clerk": "won_arranging", "Won – preparing to start": "won_preparing",
};
const CHASE = { new: "new", "our-move": "our_move", disputed: "queried", promised: "promised", waiting: "waiting" };

// ---- clients (Xero names are the standard; folder names kept as aliases)
const clientNames = new Set([...snap.overdue.map((i) => i.client), ...snap.register.map((r) => r.client)]);
must(await db.from("clients").upsert([...clientNames].map((name) => ({ name })), { onConflict: "name" }), "clients");
const clients = Object.fromEntries(must(await db.from("clients").select("id,name"), "clients read").map((c) => [c.name, c.id]));

// ---- projects from the register ("St Aidans 1073": number from BM-1073)
const projects = snap.register.map((r) => ({
  number: Number(r.ref.replace(/\D/g, "")),
  name: r.project.replace(/\s+–\s+/g, " – "),
  client_id: clients[r.client] ?? null,
  stage: STAGE[r.status] ?? "enquiry",
  agreed_days_building: r.days ?? null,
  extraction_confidence: r.conf,
  xero_invoice_prefixes: r.inv ? [r.inv] : [],
}));
for (let i = 0; i < projects.length; i += 200)
  must(await db.from("projects").upsert(projects.slice(i, i + 200), { onConflict: "number" }), "projects");
const projByNum = Object.fromEntries(must(await db.from("projects").select("id,number"), "projects read").map((p) => [p.number, p.id]));

// director-only money per project
const finance = snap.register.filter((r) => r.fee || r.rate).map((r) => ({
  project_id: projByNum[Number(r.ref.replace(/\D/g, ""))], quoted_fee: r.fee ?? null, charge_rate_building: r.rate ?? null,
}));
if (finance.length) must(await db.from("project_finance").upsert(finance, { onConflict: "project_id" }), "project_finance");

// ---- overdue invoices + chase state + Gmail history
const projByInv = Object.fromEntries(snap.register.filter((r) => r.inv).map((r) => [r.inv, projByNum[Number(r.ref.replace(/\D/g, ""))]]));
must(await db.from("invoices").upsert(snap.overdue.map((i) => ({
  number: i.number, client_id: clients[i.client] ?? null, reference: i.reference, issued: i.issued, due: i.due,
  total: i.amount, amount_due: i.amount, status: "AUTHORISED", project_id: projByInv[i.number] ?? null,
})), { onConflict: "number" }), "invoices");
const invByNum = Object.fromEntries(must(await db.from("invoices").select("id,number"), "invoices read").map((i) => [i.number, i.id]));

const states = [], events = [];
for (const i of snap.overdue) {
  const g = snap.groups[i.group];
  const id = invByNum[i.number];
  states.push({ invoice_id: id, status: CHASE[g.status] ?? "new", with_whom: g.with_whom, next_action: g.next, next_action_due: g.next_due });
  events.push({ invoice_id: id, happened_at: i.issued, source: "xero", kind: "Invoice issued", who: "Xero", body: i.reference });
  for (const e of g.events)
    events.push({ invoice_id: id, happened_at: e.date, source: e.source === "team" ? "team" : e.source === "xero" ? "xero" : "gmail",
      kind: e.kind, who: e.who, body: e.body, gmail_thread_id: e.thread });
}
must(await db.from("chase_state").upsert(states, { onConflict: "invoice_id" }), "chase_state");
await db.from("chase_events").delete().in("invoice_id", Object.values(invByNum)).in("source", ["xero", "gmail"]); // re-run safe
must(await db.from("chase_events").insert(events), "chase_events");

// ---- clerks (from October's diary)
must(await db.from("clerks").upsert(snap.diary.clerks.map((c) => ({ name: c.name })), { onConflict: "name" }), "clerks");

// ---- report queue (replace with the latest scan)
await db.from("report_queue").delete().neq("project_name", "");
must(await db.from("report_queue").insert(snap.queue.map((q) => ({
  project_name: q.project, report_name: q.name, folder: q.type, report_date: q.report, due: q.due, checker: q.checker, scanned_at: "2026-11-14T11:27:00Z",
}))), "report_queue");

// ---- finance snapshots (director only)
const F = snap.finance;
must(await db.from("finance_snapshots").insert([
  { period: "latest", cash: F.cash, receivables: F.ar.total, receivables_overdue: F.ar.overdue, sales: F.oct.sales, subcontractors: F.oct.subs, cogs: F.oct.cogs, net_profit: F.oct.net },
  { period: "2026-10", sales: F.oct.sales, subcontractors: F.oct.subs, cogs: F.oct.cogs, net_profit: F.oct.net },
  { period: "FY2026-YTD", sales: F.fytd.sales, subcontractors: F.fytd.subs, cogs: F.fytd.cogs, net_profit: F.fytd.net },
]), "finance_snapshots");

must(await db.from("sync_runs").insert({ source: "snapshot-import", finished_at: new Date().toISOString(), ok: true, message: file }), "sync_runs");
console.log(`Imported ${projects.length} projects, ${snap.overdue.length} overdue invoices, ${events.length} chase events, ${snap.diary.clerks.length} clerks, ${snap.queue.length} queued reports, finance.`);
