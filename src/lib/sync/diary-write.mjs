/**
 * Writes a parsed diary (see diary-parse.mjs) into the database with a service-role client.
 * Plain JavaScript so the website's hourly sync and a local script share it.
 */
import { siteKey, clerkKey, clerkDisplay } from "../site-key.mjs";

const must = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

export async function writeDiary(admin, d, label) {
  // ---- clerks: one per person however spelt; display the most recent spelling
  const latest = new Map();
  for (const v of d.visits) {
    if (/^other$/i.test(v.clerk)) continue;
    const k = clerkKey(v.clerk), cur = latest.get(k);
    if (!cur || v.date >= cur.date) latest.set(k, { name: clerkDisplay(v.clerk), date: v.date });
  }
  const existing = must(await admin.from("clerks").select("id,name,name_key"), "clerks");
  const clerkId = new Map();
  for (const c of existing) {
    const k = c.name_key ?? clerkKey(c.name);
    if (clerkId.has(k)) continue; // a second spelling from an earlier import: dropped at the end
    clerkId.set(k, c.id);
    if (!c.name_key) must(await admin.from("clerks").update({ name_key: k }).eq("id", c.id), "clerk key");
  }
  for (const [k, { name }] of latest) {
    if (clerkId.has(k)) continue;
    const taken = existing.some((c) => c.name === name);
    const row = must(await admin.from("clerks").insert({ name: taken ? `${name} (${k})` : name, name_key: k }).select("id").single(), "clerk insert");
    clerkId.set(k, row.id);
  }

  // ---- projects by name or diary spelling, plus sites someone has linked by hand
  const projects = must(await admin.from("projects").select("id,name,diary_aliases"), "projects");
  const byKey = new Map();
  // names first, then diary spellings: a spelling linked to one project wins when two projects share a name
  for (const p of projects) if (siteKey(p.name)) byKey.set(siteKey(p.name), p.id);
  for (const p of projects) for (const a of p.diary_aliases) if (siteKey(a)) byKey.set(siteKey(a), p.id);
  const resolved = must(await admin.from("unmatched_diary_sites").select("site_as_typed,resolved_project_id").not("resolved_project_id", "is", null), "resolved");
  for (const r of resolved) byKey.set(siteKey(r.site_as_typed), r.resolved_project_id);
  const projectFor = (site) => byKey.get(siteKey(site)) ?? null;

  // ---- visits: replace everything read from this file
  must(await admin.from("diary_visits").delete().like("source_sheet", `${label}%`), "clear visits");
  const rows = d.visits.map((v) => ({
    visit_date: v.date, clerk_id: /^other$/i.test(v.clerk) ? null : clerkId.get(clerkKey(v.clerk)) ?? null,
    project_id: projectFor(v.site), site_as_typed: v.site, kind: v.kind, side: v.side, days: 0.5,
    source_sheet: v.sheet, source_row: v.row,
  }));
  const costs = [];
  for (let i = 0; i < rows.length; i += 1000) {
    const ids = must(await admin.from("diary_visits").insert(rows.slice(i, i + 1000)).select("id"), "insert visits");
    ids.forEach((r, j) => { const c = d.visits[i + j].cost; if (c != null) costs.push({ visit_id: r.id, cost: c }); });
  }
  for (let i = 0; i < costs.length; i += 1000) must(await admin.from("clerk_costs").insert(costs.slice(i, i + 1000)), "clerk costs");

  // ---- site names that match no project (any hand-made link is kept)
  const unmatched = new Map();
  for (const v of d.visits) {
    if (projectFor(v.site)) continue;
    const u = unmatched.get(v.site) ?? { first: v.date, last: v.date, days: 0 };
    if (v.date < u.first) u.first = v.date;
    if (v.date > u.last) u.last = v.date;
    if (v.side === "charged") u.days += 0.5;
    unmatched.set(v.site, u);
  }
  must(await admin.from("unmatched_diary_sites").delete().is("resolved_project_id", null), "clear unmatched");
  if (unmatched.size)
    must(await admin.from("unmatched_diary_sites").upsert([...unmatched].map(([site_as_typed, u]) => ({
      site_as_typed, first_seen: u.first, last_seen: u.last, days: u.days,
    })), { onConflict: "site_as_typed", ignoreDuplicates: true }), "unmatched sites");

  // ---- holidays from the comments column, one entry per run of consecutive days
  must(await admin.from("absences").delete().eq("source", "diary"), "clear diary absences");
  const abs = [];
  for (const a of [...d.absences].sort((x, y) => (x.clerk + x.date).localeCompare(y.clerk + y.date))) {
    const id = clerkId.get(clerkKey(a.clerk));
    if (!id) continue;
    const last = abs.at(-1);
    const next = last && new Date(Date.parse(last.date_to + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
    if (last && last.clerk_id === id && last.kind === a.kind && next === a.date) last.date_to = a.date;
    else abs.push({ clerk_id: id, date_from: a.date, date_to: a.date, kind: a.kind, source: "diary" });
  }
  if (abs.length) must(await admin.from("absences").insert(abs), "absences");

  // ---- rates (director only), and the client invoice table → days on each invoice and its project
  if (d.rates.length) {
    const seen = new Set();
    const rates = d.rates.filter((r) => !seen.has(r.site) && seen.add(r.site))
      .map((r) => ({ site_as_typed: r.site, charge: r.charge, pay: r.pay, synced_at: new Date().toISOString() }));
    must(await admin.from("rates").upsert(rates, { onConflict: "site_as_typed" }), "rates");
  }
  const perInvoice = new Map();
  for (const l of d.invoiceLines) {
    const p = perInvoice.get(l.number) ?? { b: 0, me: 0, project: null };
    if (l.kind === "me") p.me += l.days; else p.b += l.days;
    p.project ??= projectFor(l.site);
    perInvoice.set(l.number, p);
  }
  const invoices = must(await admin.from("invoices").select("id,number,project_id").in("number", [...perInvoice.keys()]), "invoices");
  for (const i of invoices) {
    const p = perInvoice.get(i.number);
    must(await admin.from("invoices").update({ days_building: p.b, days_me: p.me, ...(i.project_id || !p.project ? {} : { project_id: p.project }) }).eq("id", i.id), "invoice days");
  }

  // ---- chase / invoice contacts from the "Invoice emails" tab: matched to a project by any part of the label after the
  // client ("Mott MacDonald - Sheffield - St Peters Batley"), otherwise to the client by its Xero name ("… - General")
  let contacts = 0;
  if (d.invoiceEmails?.length) {
    const keys = [...byKey.keys()];
    const loose = (k) => {
      if (byKey.has(k)) return byKey.get(k);
      if (k.length < 5) return null;
      const hits = new Set(keys.filter((x) => x.length >= 5 && (x.startsWith(k) || k.startsWith(x))).map((x) => byKey.get(x)));
      return hits.size === 1 ? [...hits][0] : null;
    };
    const clients = must(await admin.from("clients").select("id,name"), "clients");
    // every client whose Xero name and the label start the same way ("Mott MacDonald - Newcastle" ↔ "Mott MacDonald - (Newcastle projects)")
    const clientsFor = (label) => {
      const k = siteKey(label.replace(/\bgeneral\b/i, ""));
      // …but not a bare "Mott MacDonald" against every Mott label: the shorter name must be most of the longer one
      return clients.filter((c) => {
        const ck = siteKey(c.name);
        return ck.length >= 4 && k.length >= 4 && (k.startsWith(ck) || ck.startsWith(k)) && Math.min(ck.length, k.length) / Math.max(ck.length, k.length) >= 0.6;
      }).map((c) => c.id);
    };
    const rows = d.invoiceEmails.flatMap((e) => {
      // "WSP- St Marks", "Springstead - Bellway": split on a dash with a space on either side; try later parts first
      const parts = e.label.split(/\s*[-–]\s+|\s+[-–]\s*/);
      const project = /general/i.test(e.label) ? null : [...parts.slice(1).reverse(), parts[0]].map((p) => loose(siteKey(p))).find(Boolean) ?? null;
      const base = { label: e.label, to_emails: e.to, cc_emails: e.cc, notes: e.notes };
      if (project) return [{ ...base, project_id: project, client_id: null }];
      const cs = clientsFor(e.label);
      return cs.length ? cs.map((client_id) => ({ ...base, project_id: null, client_id })) : [{ ...base, project_id: null, client_id: null }];
    });
    must(await admin.from("invoice_contacts").delete().neq("label", ""), "clear contacts");
    must(await admin.from("invoice_contacts").insert(rows), "contacts");
    contacts = new Set(rows.filter((r) => r.project_id || r.client_id).map((r) => r.label)).size;
  }

  // ---- second spellings of a clerk from the first import, once nothing points at them
  const dupes = existing.filter((c) => c.name_key == null && clerkId.get(clerkKey(c.name)) !== c.id).map((c) => c.id);
  if (dupes.length) await admin.from("clerks").delete().in("id", dupes);

  const matched = rows.filter((r) => r.project_id).length;
  const planned = d.visits.filter((v) => v.side === "planned").length / 2;
  return `${d.visits.length / 2 - planned} days charged and ${planned} planned, ${latest.size} clerks, ${abs.length} holidays, ` +
    `${contacts} of ${d.invoiceEmails?.length ?? 0} invoice email rows matched, ` +
    `${unmatched.size} site names not matched (${((matched / Math.max(rows.length, 1)) * 100).toFixed(0)}% of days matched to a project)`;
}
