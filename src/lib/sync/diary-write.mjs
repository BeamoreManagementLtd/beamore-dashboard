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
  const projects = must(await admin.from("projects").select("id,number,name,diary_aliases"), "projects");
  const byNumber = new Map(projects.map((p) => [p.number, p.id]));
  // the diary's Projects tab, when it has one, is where the team now keeps contacts and numbers (15 Nov 2026)
  const tab = d.projectsTab?.length ? d.projectsTab : null;
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

  // ---- each project's building and M&E clerk: whoever has the most days of that kind in the diary over the last
  // 3 months and the next month (sites typed "Stanmore(M&E)" are M&E). A clerk chosen by hand is never replaced.
  {
    const from = new Date(Date.now() - 92 * 864e5).toISOString().slice(0, 10), to = new Date(Date.now() + 31 * 864e5).toISOString().slice(0, 10);
    const tally = new Map(); // project|kind → clerk → days
    for (const v of rows) {
      if (!v.project_id || !v.clerk_id || v.visit_date < from || v.visit_date > to) continue;
      const k = `${v.project_id}|${v.kind}`;
      const m = tally.get(k) ?? new Map();
      m.set(v.clerk_id, (m.get(v.clerk_id) ?? 0) + 0.5);
      tally.set(k, m);
    }
    const top = (k) => { const m = tally.get(k); return m ? [...m].sort((a, b) => b[1] - a[1])[0][0] : null; };
    const projIds = [...new Set(rows.map((v) => v.project_id).filter(Boolean))];
    const cur = [];
    for (let i = 0; i < projIds.length; i += 200) cur.push(...must(await admin.from("projects").select("id,clerk_id,clerk_source,clerk_me_id,clerk_me_source,clerk_me_status").in("id", projIds.slice(i, i + 200)), "clerks now"));
    const jobs = [];
    for (const p of cur) {
      const b = top(`${p.id}|building`), m = top(`${p.id}|me`);
      const upd = {};
      if (b && p.clerk_source !== "manual" && p.clerk_id !== b) Object.assign(upd, { clerk_id: b, clerk_source: "diary", clerk_status: "have" });
      if (m && p.clerk_me_source !== "manual" && p.clerk_me_id !== m) Object.assign(upd, { clerk_me_id: m, clerk_me_source: "diary", clerk_me_status: "have" });
      if (Object.keys(upd).length) jobs.push(() => admin.from("projects").update(upd).eq("id", p.id));
    }
    for (let i = 0; i < jobs.length; i += 12) await Promise.all(jobs.slice(i, i + 12).map((j) => j()));
  }

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
  // keep rows someone linked to a project or marked "not a project"
  must(await admin.from("unmatched_diary_sites").delete().is("resolved_project_id", null).eq("ignored", false), "clear unmatched");
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

  // holidays entered in the dashboard: done once every weekday of them shows as a holiday in the diary
  const inDiary = new Set(d.absences.map((a) => `${clerkId.get(clerkKey(a.clerk))}|${a.date}`));
  const pending = must(await admin.from("absences").select("id,clerk_id,date_from,date_to,synced_to_diary_at").eq("source", "dashboard").neq("status", "cancelled"), "dashboard holidays");
  for (const p of pending) {
    let all = true;
    for (let t = Date.parse(p.date_from + "T00:00:00Z"); t <= Date.parse(p.date_to + "T00:00:00Z"); t += 86400000) {
      const day = new Date(t);
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      if (!inDiary.has(`${p.clerk_id}|${day.toISOString().slice(0, 10)}`)) { all = false; break; }
    }
    if (all !== !!p.synced_to_diary_at)
      must(await admin.from("absences").update({ synced_to_diary_at: all ? new Date().toISOString() : null }).eq("id", p.id), "holiday tick");
  }

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
  if (tab || d.invoiceEmails?.length) {
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
    const rows = tab ? tab.filter((t) => t.invoiceTo.length).flatMap((t) => {
      // Projects tab: the job number says which project; a "(all projects)" row is the client's default
      const base = { label: `${t.company} - ${t.project}`, to_emails: t.invoiceTo, cc_emails: t.invoiceCc, notes: t.invoiceNotes };
      const project = (t.job && byNumber.get(t.job)) || (/^\(all projects\)$/i.test(t.project) ? null : loose(siteKey(t.project)));
      if (project) return [{ ...base, project_id: project, client_id: null }];
      const cs = clientsFor(t.company);
      return cs.length ? cs.map((client_id) => ({ ...base, project_id: null, client_id })) : [{ ...base, project_id: null, client_id: null }];
    }) : d.invoiceEmails.flatMap((e) => {
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

  // ---- checklist items the diary answers: ticked with the actual value (replacing "assumed received").
  // Everything is worked out in memory first, then written in parallel batches (the sync has a time limit).
  const today = new Date().toISOString().slice(0, 10);
  const parallel = async (jobs, n = 12) => { for (let i = 0; i < jobs.length; i += n) await Promise.all(jobs.slice(i, i + n).map((j) => j())); };
  const info = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await admin.from("project_info").select("id,project_id,item,received_on,note").range(from, from + 999), "info");
    info.push(...page);
    if (page.length < 1000) break;
  }
  const infoTicks = new Map(); // project_info id → update
  const tick = (projectId, itemRe, note) => {
    for (const i of info.filter((x) => x.project_id === projectId && itemRe.test(x.item)))
      if (!i.received_on || !i.note || /^Assumed/.test(i.note) || /^From the diary/.test(i.note))
        infoTicks.set(i.id, { received_on: i.received_on ?? today, note: note.slice(0, 500) });
  };
  const siteProject = (site) => projectFor(site) ?? (() => { const k = siteKey(site); if (byKey.has(k)) return byKey.get(k); if (k.length < 5) return null;
    const hits = new Set([...byKey.keys()].filter((x) => x.length >= 5 && (x.startsWith(k) || k.startsWith(x))).map((x) => byKey.get(x))); return hits.size === 1 ? [...hits][0] : null; })();
  const projUpd = new Map(); // project id → fields
  const setP = (pid, fields) => projUpd.set(pid, { ...(projUpd.get(pid) ?? {}), ...fields });
  const current = new Map(must(await admin.from("projects").select("id,po_number,dfe_project_number"), "projects").map((p) => [p.id, p]));

  // "Report emails" → distribution list
  const distProjects = new Set();
  if (tab) for (const t of tab) {
    const pid = (t.job && byNumber.get(t.job)) || siteProject(t.project);
    if (!pid || !t.reportTo.length) continue;
    setP(pid, { report_to: t.reportTo.join("; "), report_cc: t.reportCc.join("; ") || null });
    tick(pid, /distribution list/i, `From the diary (Projects): to ${t.reportTo.join(", ")}${t.reportCc.length ? `; cc ${t.reportCc.join(", ")}` : ""}`);
    distProjects.add(pid);
  }
  for (const e of tab ? [] : d.reportEmails ?? []) {
    const pid = siteProject(e.site);
    if (!pid) continue;
    setP(pid, { report_to: e.to.join("; "), report_cc: e.cc.join("; ") || null, inspection_frequency: e.inspection, reporting_frequency: e.reporting });
    tick(pid, /distribution list/i, `From the diary (Report emails): to ${e.to.join(", ")}${e.cc.length ? `; cc ${e.cc.join(", ")}` : ""}`);
    distProjects.add(pid);
  }
  const distLists = distProjects.size;

  // "Invoice POs" → PO number and the DfE (SRP) project number
  const poProjects = new Set();
  // Projects tab: its PO and DfE numbers are the ones to use (the team keeps them there now), first one if several
  if (tab) for (const t of tab) {
    const pid = (t.job && byNumber.get(t.job)) || siteProject(t.project);
    if (!pid) continue;
    const po = t.po.split(/\s*\/\s*/).map((x) => x.trim()).find((x) => /\d/.test(x));
    const dfe = [...`${t.dfe} ${t.projectNumber}`.matchAll(/\b(SRP|FS|FE|PSBP)\s?(\d{3,4})\b/gi)].map((m) => `${m[1].toUpperCase()}${m[2]}`)[0];
    if (po) {
      if (current.get(pid)?.po_number !== po) setP(pid, { po_number: po });
      tick(pid, /\bPO\b/, `From the diary (Projects): ${t.po}`);
      poProjects.add(pid);
    }
    if (dfe) {
      if (current.get(pid)?.dfe_project_number !== dfe) setP(pid, { dfe_project_number: dfe });
      tick(pid, /DfE project number/i, `From the diary (Projects): ${dfe}`);
    }
  }
  for (const p of tab ? [] : d.invoicePOs ?? []) {
    const pid = siteProject(p.site);
    if (!pid) continue;
    const all = `${p.poText} ${p.projectNumber} ${p.other}`;
    const srp = /\bSRP\s?(\d{3,4})\b/i.exec(all);
    const poNo = /\b(MM\d{6,}|PO[\s:#-]*([A-Z0-9-]{4,})|\d{5,})\b/i.exec(p.poText.replace(/SRP\s?\d+/gi, ""));
    const value = poNo ? (poNo[2] ?? poNo[1]) : null;
    if (value) {
      if (!current.get(pid)?.po_number) setP(pid, { po_number: value });
      tick(pid, /\bPO\b/, `From the diary (Invoice POs): ${p.poText}`);
      poProjects.add(pid);
    }
    if (srp) {
      if (!current.get(pid)?.dfe_project_number) setP(pid, { dfe_project_number: `SRP${srp[1]}` });
      tick(pid, /DfE project number/i, `From the diary (Invoice POs): SRP${srp[1]}`);
    }
  }
  const pos = poProjects.size;

  // "Contact details" → clerks' phone and email where the dashboard has none
  const clerkRows = new Map(must(await admin.from("clerks").select("id,email,phone"), "clerks").map((c) => [c.id, c]));
  const clerkUpd = [];
  for (const c of d.contactDetails ?? []) {
    const id = clerkId.get(clerkKey(c.name));
    const cur = id && clerkRows.get(id);
    if (!cur) continue;
    const upd = { ...(!cur.email && (c.email || c.email2) ? { email: c.email ?? c.email2 } : {}), ...(!cur.phone && c.phone ? { phone: c.phone } : {}) };
    if (Object.keys(upd).length) clerkUpd.push([id, upd]);
  }
  const clerkContacts = clerkUpd.length;

  await parallel([...projUpd].map(([id, fields]) => async () => must(await admin.from("projects").update(fields).eq("id", id), "project details")));
  await parallel([...infoTicks].map(([id, fields]) => async () => must(await admin.from("project_info").update(fields).eq("id", id), "tick")));
  await parallel(clerkUpd.map(([id, upd]) => async () => must(await admin.from("clerks").update(upd).eq("id", id), "clerk contact")));

  // ---- second spellings of a clerk from the first import, once nothing points at them
  const dupes = existing.filter((c) => c.name_key == null && clerkId.get(clerkKey(c.name)) !== c.id).map((c) => c.id);
  if (dupes.length) await admin.from("clerks").delete().in("id", dupes);

  const matched = rows.filter((r) => r.project_id).length;
  const planned = d.visits.filter((v) => v.side === "planned").length / 2;
  return `${d.visits.length / 2 - planned} days charged and ${planned} planned, ${latest.size} clerks, ${abs.length} holidays, ` +
    (tab ? `Projects tab: ${tab.length} projects, ${contacts} with invoice contacts matched, ` : `${contacts} of ${d.invoiceEmails?.length ?? 0} invoice email rows matched, `) +
    `${distLists} distribution lists, ${pos} PO numbers, ${clerkContacts} clerk contact details, ` +
    `${unmatched.size} site names not matched (${((matched / Math.max(rows.length, 1)) * 100).toFixed(0)}% of days matched to a project)`;
}
