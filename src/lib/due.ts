import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile } from "@/lib/auth";
import { SCOPES_CHANGED_AT } from "@/lib/xero";
import { GOOGLE_SCOPES_CHANGED_AT } from "@/lib/google";
import { loadWorkflows, WORKFLOW_COLUMNS, daysSince, type WorkflowProject } from "@/lib/workflow";

/**
 * The team due list. Most items are worked out from live data each time (they disappear once the underlying thing is
 * done); people can also add their own tasks. Default owners: chasing → Judy, report checks → the named checker,
 * linking/sign-off → the director.
 */
export type DueItem = {
  key: string;
  title: string;
  detail?: string;
  due: string | null;          // yyyy-mm-dd
  owner: string | null;        // display name ("Judy", "Ronan") or null = unassigned
  ownerId: string | null;
  kind: "Chasing" | "Reports" | "Projects" | "Personnel" | "Diary" | "Xero" | "Task";
  link?: string;
  taskId?: string;             // manual tasks can be ticked off
};

const londonToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const first = (s?: string | null) => (s ?? "").split(/\s+/)[0].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const MONTH = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

export async function buildDueList(db: SupabaseClient, me: Profile): Promise<DueItem[]> {
  const t = londonToday();
  const director = me.role === "director";

  const [profiles, chases, queue, projects, compliance, tasks, unmatchedSites, unmatchedRefs, runs, signoffs, planned] = await Promise.all([
    db.from("profiles").select("id,full_name,email,role"),
    db.from("invoices").select("id,number,due,amount_due,clients(name),chase_state(status,next_action,next_action_due,promised_date,owner_id)").gt("amount_due", 0).lt("due", t),
    db.from("report_queue").select("checker,due"),
    db.from("projects").select("id,display_name,next_action,next_action_due,owner_id").not("next_action_due", "is", null).lte("next_action_due", addDays(t, 14)),
    db.from("clerk_compliance").select("clerk_id,dbs_recheck,chartership_renewal,pi_insurance_expiry,pl_insurance_expiry,cscs_expiry,onboarding_started,onboarding_complete,clerks(name,active)"),
    db.from("tasks").select("id,title,kind,due,link,owner_id").is("done_at", null),
    db.from("unmatched_diary_sites").select("site_as_typed", { count: "exact", head: true }).is("resolved_project_id", null).eq("ignored", false),
    db.from("unmatched_invoice_refs").select("reference_key", { count: "exact", head: true }),
    db.from("sync_runs").select("source,ok,message,started_at").in("source", ["xero", "diary"]).order("started_at", { ascending: false }).limit(10),
    db.from("month_signoffs").select("month"),
    db.from("diary_visits").select("id", { count: "exact", head: true }).eq("side", "planned").gte("visit_date", t.slice(0, 7) + "-01"),
  ]);

  const people = profiles.data ?? [];
  const byFirst = (name: string) => people.find((p) => first(p.full_name ?? p.email) === first(name));
  const ownerOf = (id: string | null | undefined, fallbackName: string | null) => {
    const p = id ? people.find((x) => x.id === id) : fallbackName ? byFirst(fallbackName) : undefined;
    return { owner: p ? (p.full_name ?? p.email).split(" ")[0] : fallbackName, ownerId: p?.id ?? null };
  };
  const directorName = people.find((p) => p.role === "director")?.full_name?.split(" ")[0] ?? "Ronan";
  const items: DueItem[] = [];

  // ---- chasing (Judy unless someone else owns the chase)
  type Chase = { status: string; next_action: string | null; next_action_due: string | null; promised_date: string | null; owner_id: string | null };
  // Weekly rhythm: an overdue invoice comes back 7 days after its last chase (a chase email seen in Gmail, or a phone
  // call / email logged by the team), so it isn't on the list every day. A next-action date typed by hand wins if later.
  let notChased = 0, oldestNew: string | null = null;
  const overdueIds = (chases.data ?? []).map((i) => i.id);
  const lastChase = new Map<string, string>();
  for (let k = 0; k < overdueIds.length; k += 150) {
    const { data: ev } = await db.from("chase_events").select("invoice_id,happened_at").in("invoice_id", overdueIds.slice(k, k + 150)).in("kind", ["Email sent", "Phone call"]);
    for (const e of ev ?? []) if ((lastChase.get(e.invoice_id) ?? "") < e.happened_at) lastChase.set(e.invoice_id, e.happened_at);
  }
  for (const i of chases.data ?? []) {
    const raw = i.chase_state as unknown;
    const cs = (Array.isArray(raw) ? raw[0] : raw) as Chase | null;
    const client = (i.clients as unknown as { name: string } | null)?.name ?? "";
    const link = `/invoices/${encodeURIComponent(i.number)}`;
    const last = lastChase.get(i.id)?.slice(0, 10);
    if (cs?.status === "our_move") { // the client has written back: answer them, no weekly wait
      items.push({ key: `ourmove-${i.id}`, kind: "Chasing", title: `${i.number}: we owe ${client} a reply`, due: t, link, ...ownerOf(cs.owner_id, "Judy") });
      continue;
    }
    if (cs?.promised_date && cs.promised_date >= t) continue; // payment promised: wait for the date
    if (cs?.promised_date && cs.promised_date < t) {
      items.push({ key: `promise-${i.id}`, kind: "Chasing", title: `${i.number}: promised payment hasn't arrived`, detail: `${client} promised ${cs.promised_date}`, due: cs.promised_date, link, ...ownerOf(cs.owner_id, "Judy") });
      continue;
    }
    if (!last && (!cs || cs.status === "new")) { notChased++; if (!oldestNew || i.due < oldestNew) oldestNew = i.due; continue; }
    const weekly = last ? addDays(last, 7) : t;
    const next = cs?.next_action_due && cs.next_action_due > weekly ? cs.next_action_due : weekly;
    if (next > t) continue; // chased in the last week: back on the list on `next`
    const ago = last ? Math.round((Date.parse(t) - Date.parse(last)) / 864e5) : null;
    items.push({ key: `chase-${i.id}`, kind: "Chasing", title: `Chase ${i.number} again`, detail: `${client}${ago != null ? ` · last chased ${ago} days ago (${last})` : ""}${cs?.next_action ? ` · ${cs.next_action}` : ""}`, due: next, link, ...ownerOf(cs?.owner_id, "Judy") });
  }
  if (notChased)
    items.push({ key: "not-chased", kind: "Chasing", title: `${notChased} overdue invoice${notChased > 1 ? "s" : ""} not chased yet`, detail: "Start with the oldest", due: t, link: "/invoices", ...ownerOf(null, "Judy") });

  // ---- reports waiting to check, one line per checker
  const q = queue.data ?? [];
  const checkers = [...new Set(q.map((r) => r.checker ?? "Unknown"))];
  for (const c of checkers) {
    const mine = q.filter((r) => (r.checker ?? "Unknown") === c);
    const late = mine.filter((r) => r.due && r.due < t).length;
    const earliest = mine.map((r) => r.due).filter(Boolean).sort()[0] ?? null;
    if (c === "Unknown")
      items.push({ key: "reports-nochecker", kind: "Reports", title: `${mine.length} report${mine.length > 1 ? "s" : ""} with no checker`, detail: "Add these projects to the report scanner's checker list", due: earliest, link: "/reports?checker=Unknown", ...ownerOf(null, directorName) });
    else
      items.push({ key: `reports-${c}`, kind: "Reports", title: `Check ${mine.length} report${mine.length > 1 ? "s" : ""}`, detail: late ? `${late} past due` : undefined, due: earliest, link: `/reports?checker=${encodeURIComponent(c)}`, ...ownerOf(null, c) });
  }

  // ---- project information asked for over a week ago and not received (one line per project)
  const { data: info } = await db.from("project_info").select("project_id,item,requested_on,projects(id,display_name)")
    .not("requested_on", "is", null).is("received_on", null).lte("requested_on", addDays(t, -7));
  const byProj = new Map<string, { name: string; items: string[]; since: string }>();
  for (const i of info ?? []) {
    const p = i.projects as unknown as { id: string; display_name: string } | null;
    if (!p) continue;
    const x = byProj.get(p.id) ?? { name: p.display_name, items: [] as string[], since: String(i.requested_on) };
    x.items.push(String(i.item)); if (String(i.requested_on) < x.since) x.since = String(i.requested_on);
    byProj.set(p.id, x);
  }
  for (const [pid, x] of byProj)
    items.push({ key: `info-${pid}`, kind: "Projects", title: `${x.name}: chase the client for project information`, detail: x.items.join(", "), due: addDays(x.since, 7), link: `/projects/${pid}`, ...ownerOf(null, "Judy") });

  // ---- project workflows (docs/workflows.html): pricing, set-up and close-out reminders
  {
    const { data: active } = await db.from("projects").select(`${WORKFLOW_COLUMNS},display_name`)
      .in("stage", ["enquiry", "pricing", "sent", "won_arranging", "won_preparing", "live"]);
    // enquiries imported from the register with no date are left alone (93 "Check status" rows)
    const list = ((active ?? []) as unknown as (WorkflowProject & { display_name: string })[])
      .filter((p) => p.stage_changed_at || !["enquiry", "pricing"].includes(p.stage));
    const wfs = await loadWorkflows(db, list);
    const judy = ownerOf(null, "Judy");
    for (const p of list) {
      const w = wfs.get(p.id)!;
      const days = daysSince(p.stage_changed_at) ?? 0;
      const link = `/projects/${p.id}`;
      const add = (title: string, detail: string, owner: { owner: string | null; ownerId: string | null }, due: string | null = t) =>
        items.push({ key: `wf-${p.id}`, kind: "Projects", title, detail, due, link, ...owner });
      const toDirector = director ? ownerOf(me.id, null) : ownerOf(null, directorName);
      if (w.current === "pricing" && p.is_dfe != null) {
        if (p.stage !== "sent" && p.stage_changed_at && days >= 2)
          add(`Price ${p.display_name}`, `Asked to price ${days} days ago. Ticks itself when the proposal shows in your sent email`, toDirector, addDays(p.stage_changed_at.slice(0, 10), 2));
        else if (p.stage === "sent" && w.status.waitingOn === "you")
          add(`Won or lost: ${p.display_name}?`, w.status.text, toDirector);
        else if (p.stage === "sent" && p.stage_changed_at && days >= 30)
          add(`Is ${p.display_name} still live?`, `Proposal sent ${days} days ago with no reply. Mark it Lost, or chase once more`, toDirector);
        else if (p.stage === "sent" && p.stage_changed_at && days >= 7)
          add(`Ask for a reply: ${p.display_name}`, `Proposal sent ${days} days ago, no reply yet. Reminds again every 7 days`, toDirector, addDays(p.stage_changed_at.slice(0, 10), 7 * Math.floor(days / 7)));
      } else if (w.current === "setup" && (w.status.waitingOn === "us" || w.status.waitingOn === "admin")) {
        const clerkStep = w.stages[1].steps.find((x) => x.state === "now")?.id === "S3";
        add(`Set up ${p.display_name}`, w.status.text, clerkStep ? toDirector : judy);
      } else if (w.current === "start" && w.status.waitingOn === "you") {
        add(`Has ${p.display_name} started on site?`, w.status.text, toDirector);
      } else if (w.current === "start" && w.status.waitingOn === "admin" && p.start_date && p.start_date <= addDays(t, 14)) {
        add(`Book the clerk in the diary for ${p.display_name}`, w.status.text, judy, addDays(p.start_date, -14) < t ? t : addDays(p.start_date, -14));
      } else if (w.current === "closeout" && w.quiet)
        add(`Is ${p.display_name} finished, paused or still going?`, w.status.text.replace(/ Waiting on you.*$/, ""), toDirector);
    }
  }

  // ---- finding a clerk (workflow 3): daily once the job starts within three weeks
  {
    const { data: findB } = await db.from("projects").select("id,display_name,start_date").eq("clerk_status", "finding").is("clerk_id", null).in("stage", ["won_arranging", "won_preparing", "live"]);
    const { data: findM } = await db.from("projects").select("id,display_name,start_date").eq("clerk_me_status", "finding").is("clerk_me_id", null).in("stage", ["won_arranging", "won_preparing", "live"]);
    const finding = [...(findB ?? []).map((p) => ({ ...p, role: "" })), ...(findM ?? []).map((p) => ({ ...p, role: "M&E " }))];
    for (const p of finding) {
      const soon = !p.start_date || p.start_date <= addDays(t, 21);
      items.push({ key: `findclerk-${p.role}${p.id}`, kind: "Projects", title: `Find ${p.role ? "an M&E" : "a"} clerk for ${p.display_name}`, detail: p.start_date ? `Starts ${p.start_date}` : "No start date yet: add one on the project", due: soon ? t : addDays(p.start_date!, -21), link: `/projects/${p.id}`, ...(director ? ownerOf(me.id, null) : ownerOf(null, directorName)) });
    }
  }

  // ---- P1: pricing requests spotted in email, waiting for a yes or no
  {
    const { data: reqs } = await db.from("price_requests").select("id,subject,from_name,received_at").eq("status", "new").order("received_at");
    for (const q of reqs ?? [])
      items.push({ key: `pricereq-${q.id}`, kind: "Projects", title: `Pricing request? ${q.subject ?? ""}`.slice(0, 120), detail: `From ${q.from_name ?? "?"}. Create the enquiry or mark it as not a request`, due: q.received_at?.slice(0, 10) ?? t, link: "/projects/requests", ...(director ? ownerOf(me.id, null) : ownerOf(null, directorName)) });
  }

  // ---- draft invoices sitting in Xero for over a week (contacts held on purpose, e.g. Portakabin, left out)
  if (director) {
    const [{ data: drafts }, { data: held }, { data: heldInv }] = await Promise.all([
      db.from("xero_draft_invoices").select("number,contact,issued,subtotal").lte("issued", addDays(t, -7)),
      db.from("held_draft_contacts").select("contact"),
      db.from("held_draft_invoices").select("number"),
    ]);
    const heldSet = new Set((held ?? []).map((h) => h.contact.toLowerCase()));
    const heldNos = new Set((heldInv ?? []).map((h) => h.number));
    const waiting = (drafts ?? []).filter((d) => !heldSet.has((d.contact ?? "").toLowerCase()) && !heldNos.has(d.number ?? ""));
    if (waiting.length) {
      const total = waiting.reduce((s, d) => s + Number(d.subtotal ?? 0), 0);
      const oldest = waiting.map((d) => d.issued).sort()[0];
      items.push({ key: "xero-drafts", kind: "Xero", title: `${waiting.length} draft invoice${waiting.length > 1 ? "s" : ""} in Xero not sent (£${Math.round(total).toLocaleString("en-GB")} ex VAT)`,
        detail: `${waiting.map((d) => d.number).join(", ")}. Oldest dated ${oldest}. Approve and send in Xero, or delete if not needed`, due: t, link: "/finance", ...ownerOf(me.id, null) });
    }
  }

  // ---- the DfE check couldn't decide: ask the director rather than guess
  if (director) {
    const { data: unsure } = await db.from("projects").select("id,display_name,dfe_evidence").is("is_dfe", null).like("dfe_evidence", "Unsure%");
    for (const p of unsure ?? [])
      items.push({ key: `dfe-${p.id}`, kind: "Projects", title: `Is ${p.display_name} a DfE project?`, detail: `${(p.dfe_evidence ?? "").replace(/^Unsure: /, "")}. Answer with one click (sets the right checklist)`, due: t, link: `/projects/dfe`, ...ownerOf(me.id, null) });
  }

  // ---- replies to cost proposals that read like a go-ahead (director confirms; nothing changes by itself)
  if (director) {
    const { data: ga } = await db.from("project_events").select("id,project_id,happened_at,who,body,projects(display_name,stage)")
      .eq("kind", "Possible go-ahead").gte("happened_at", addDays(t, -21));
    for (const e of ga ?? []) {
      const p = e.projects as unknown as { display_name: string; stage: string } | null;
      if (!p || ["won_arranging", "won_preparing", "live", "complete", "lost"].includes(p.stage)) continue;
      items.push({ key: `goahead-${e.id}`, kind: "Projects", title: `Possible go-ahead: ${p.display_name}`, detail: `${e.who}: ${(e.body ?? "").replace(/\s*\[[^\]]+\]$/, "").slice(0, 120)}. If won, change its stage`, due: e.happened_at.slice(0, 10), link: `/projects/${e.project_id}`, ...ownerOf(me.id, null) });
    }
  }

  // ---- project next actions
  for (const p of projects.data ?? [])
    items.push({ key: `project-${p.id}`, kind: "Projects", title: `${p.display_name}: ${p.next_action ?? "next action"}`, due: p.next_action_due, link: "/projects", ...ownerOf(p.owner_id, null) });

  // ---- clerk compliance renewals in the next 30 days (or overdue)
  for (const c of compliance.data ?? []) {
    const name = (c.clerks as unknown as { name: string } | null)?.name ?? "Clerk";
    if (c.dbs_recheck && c.dbs_recheck <= addDays(t, 30))
      items.push({ key: `dbs-${name}`, kind: "Personnel", title: `${name}: DBS recheck due`, due: c.dbs_recheck, link: "/personnel", ...ownerOf(null, "Judy") });
    if (c.chartership_renewal && c.chartership_renewal <= addDays(t, 30))
      items.push({ key: `chart-${name}`, kind: "Personnel", title: `${name}: chartership renewal due`, due: c.chartership_renewal, link: "/personnel", ...ownerOf(null, "Judy") });
    const clerkLink = `/personnel/${c.clerk_id}`;
    const active = (c.clerks as unknown as { active: boolean } | null)?.active !== false;
    for (const [field, label] of [["pi_insurance_expiry", "professional indemnity insurance"], ["pl_insurance_expiry", "public liability insurance"], ["cscs_expiry", "CSCS card"]] as const) {
      const d = c[field] as string | null;
      if (active && d && d <= addDays(t, 30))
        items.push({ key: `${field}-${c.clerk_id}`, kind: "Personnel", title: `${name}: ${label} ${d < t ? "expired" : "expires soon"}`, detail: "Ask for the new certificate and update the date", due: d, link: clerkLink, ...ownerOf(null, "Judy") });
    }
    if (c.onboarding_started && !c.onboarding_complete)
      items.push({ key: `onboard-${c.clerk_id}`, kind: "Personnel", title: `Onboard ${name}`, detail: "New clerk: insurance, DBS, CSCS, PPE, terms and set-up. Not ready for site until it's all done", due: addDays(c.onboarding_started as string, 7), link: clerkLink, ...ownerOf(null, "Judy") });
  }

  // ---- holidays: dashboard entries still to go in the diary, and planned (grey) visits on holiday days
  const { data: hols } = await db.from("absences").select("id,clerk_id,date_from,date_to,part_day,source,synced_to_diary_at,clerks(name)")
    .gte("date_to", t).neq("status", "cancelled");
  const span = (a: { date_from: string; date_to: string }) => (a.date_from === a.date_to ? a.date_from : `${a.date_from} – ${a.date_to}`);
  for (const h of hols ?? []) {
    const name = (h.clerks as unknown as { name: string } | null)?.name ?? "Clerk";
    if (h.source === "dashboard" && !h.synced_to_diary_at)
      items.push({ key: `hol-${h.id}`, kind: "Personnel", title: `Add ${name}'s holiday to the diary`, detail: `${span(h)}${h.part_day ? ` (${h.part_day})` : ""}: put "Holiday" in the comments`, due: addDays(h.date_from, -7) < t ? t : addDays(h.date_from, -7), link: "/personnel", ...ownerOf(null, "Judy") });
    const { data: clash } = await db.from("diary_visits").select("visit_date,site_as_typed").eq("clerk_id", h.clerk_id).eq("side", "planned")
      .gte("visit_date", h.date_from < t ? t : h.date_from).lte("visit_date", h.date_to).order("visit_date").limit(5);
    if (clash?.length)
      items.push({ key: `clash-${h.id}`, kind: "Diary", title: `${name} is on holiday but planned on site`, detail: clash.map((c) => `${c.visit_date.slice(5)} ${c.site_as_typed}`).join(", "), due: clash[0].visit_date, link: `/personnel/${h.clerk_id}`, ...ownerOf(null, directorName) });
  }

  // ---- clerks working with us (diary in the last 60 days) with no DBS record yet
  const [{ data: act }, { data: withDbs }] = await Promise.all([
    db.from("clerk_activity").select("clerk_id").gte("last_visit", addDays(t, -60)),
    db.from("clerk_compliance").select("clerk_id").not("dbs_status", "is", null),
  ]);
  const noDbs = (act ?? []).filter((a) => !(withDbs ?? []).some((w) => w.clerk_id === a.clerk_id)).length;
  if (noDbs)
    items.push({ key: "dbs-missing", kind: "Personnel", title: `Add DBS details for ${noDbs} clerk${noDbs > 1 ? "s" : ""}`, detail: "Working with us but no DBS record in the dashboard", due: null, link: "/personnel", ...ownerOf(null, "Judy") });

  // ---- diary month routine (the grey/salmon layout starts with November 2026)
  const monthStart = t.slice(0, 7) + "-01";
  const lastMonth = addDays(monthStart, -1).slice(0, 7) + "-01";
  const nextMonth = addDays(monthStart, 32).slice(0, 7) + "-01";
  if (monthStart >= "2026-11-01" && !planned.count)
    items.push({ key: `plan-${monthStart}`, kind: "Diary", title: `Fill in the grey (planned) side for ${MONTH(monthStart)}`, detail: "From the cost proposals", due: monthStart, ...ownerOf(null, directorName) });
  if (t >= addDays(nextMonth, -5)) { // last few days of the month: plan the next one
    const { count } = await db.from("diary_visits").select("id", { count: "exact", head: true }).eq("side", "planned").gte("visit_date", nextMonth);
    if (!count) items.push({ key: `plan-${nextMonth}`, kind: "Diary", title: `Fill in the grey (planned) side for ${MONTH(nextMonth)}`, detail: "From the cost proposals", due: nextMonth, ...ownerOf(null, directorName) });
  }
  if (lastMonth >= "2026-11-01" && !(signoffs.data ?? []).some((s) => s.month === lastMonth))
    items.push({ key: `signoff-${lastMonth}`, kind: "Diary", title: `Compare planned and charged for ${MONTH(lastMonth)}, then sign off invoicing`, due: addDays(monthStart, 2), link: `/signoff?month=${lastMonth.slice(0, 7)}`, ...ownerOf(null, directorName) });
  if (unmatchedSites.count)
    items.push({ key: "unmatched-sites", kind: "Diary", title: `${unmatchedSites.count} diary site name${unmatchedSites.count > 1 ? "s" : ""} not linked to a project`, due: null, link: "/projects", ...ownerOf(null, directorName) });
  if (unmatchedRefs.count)
    items.push({ key: "unmatched-refs", kind: "Xero", title: `${unmatchedRefs.count} Xero invoice reference${unmatchedRefs.count > 1 ? "s" : ""} not linked to a project`, due: null, link: "/projects", ...ownerOf(null, directorName) });

  // ---- Xero connection made before the tracking permission was added (director only)
  if (director) {
    const { data: xc } = await db.rpc("xero_connection_status");
    const conn = (xc as { connected_at: string }[] | null)?.[0];
    if (conn && conn.connected_at < SCOPES_CHANGED_AT)
      items.push({ key: "xero-reconnect", kind: "Xero", title: "Reconnect Xero so draft invoices can be tagged by project", detail: "Finance → Xero → Reconnect (reads the Project tracking options)", due: addDays(nextMonth, -3), link: "/finance", ...ownerOf(me.id, null) });
    const { data: gc } = await db.rpc("google_connection_status");
    const g = (gc as { connected_at: string }[] | null)?.[0];
    if (g && g.connected_at < GOOGLE_SCOPES_CHANGED_AT)
      items.push({ key: "google-reconnect", kind: "Xero", title: "Reconnect Google once so the dashboard can make project folders and save email drafts", detail: "Finance → Google → Reconnect. It still never deletes files or sends emails", due: t, link: "/finance", ...ownerOf(me.id, null) });
  }

  // ---- a sync that's failing (director only: it's about the connections)
  if (director)
    for (const src of ["xero", "diary"]) {
      const last = (runs.data ?? []).find((r) => r.source === src);
      if (last && last.ok === false)
        items.push({ key: `sync-${src}`, kind: src === "xero" ? "Xero" : "Diary", title: `${src === "xero" ? "Xero" : "Diary"} sync is failing`, detail: last.message ?? undefined, due: t, link: "/finance", ...ownerOf(me.id, null) });
    }

  // ---- tasks people added
  for (const k of tasks.data ?? [])
    items.push({ key: `task-${k.id}`, kind: "Task", title: k.title, detail: k.kind ?? undefined, due: k.due, link: k.link ?? undefined, taskId: k.id, ...ownerOf(k.owner_id, null) });

  return items.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
}

export const isMine = (i: DueItem, me: Profile) =>
  i.ownerId === me.id || (!i.ownerId && !!i.owner && first(i.owner) === first(me.full_name ?? me.email));
