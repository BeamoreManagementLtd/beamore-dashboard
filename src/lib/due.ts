import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile } from "@/lib/auth";
import { SCOPES_CHANGED_AT } from "@/lib/xero";

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
  const soon = addDays(t, 7);
  const director = me.role === "director";

  const [profiles, chases, queue, projects, compliance, tasks, unmatchedSites, unmatchedRefs, runs, signoffs, planned] = await Promise.all([
    db.from("profiles").select("id,full_name,email,role"),
    db.from("invoices").select("id,number,due,amount_due,clients(name),chase_state(status,next_action,next_action_due,promised_date,owner_id)").gt("amount_due", 0).lt("due", t),
    db.from("report_queue").select("checker,due"),
    db.from("projects").select("id,display_name,next_action,next_action_due,owner_id").not("next_action_due", "is", null).lte("next_action_due", addDays(t, 14)),
    db.from("clerk_compliance").select("dbs_recheck,chartership_renewal,clerks(name)"),
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
  let notChased = 0, oldestNew: string | null = null;
  for (const i of chases.data ?? []) {
    const raw = i.chase_state as unknown;
    const cs = (Array.isArray(raw) ? raw[0] : raw) as Chase | null;
    const client = (i.clients as unknown as { name: string } | null)?.name ?? "";
    const link = `/invoices/${encodeURIComponent(i.number)}`;
    if (!cs || cs.status === "new") { notChased++; if (!oldestNew || i.due < oldestNew) oldestNew = i.due; continue; }
    if (cs.promised_date && cs.promised_date < t)
      items.push({ key: `promise-${i.id}`, kind: "Chasing", title: `${i.number}: promised payment hasn't arrived`, detail: `${client} promised ${cs.promised_date}`, due: cs.promised_date, link, ...ownerOf(cs.owner_id, "Judy") });
    else if (cs.next_action_due && cs.next_action_due <= soon)
      items.push({ key: `chase-${i.id}`, kind: "Chasing", title: `${i.number}: ${cs.next_action ?? "chase"}`, detail: client, due: cs.next_action_due, link, ...ownerOf(cs.owner_id, "Judy") });
    else if (!cs.next_action_due && cs.status === "our_move")
      items.push({ key: `ourmove-${i.id}`, kind: "Chasing", title: `${i.number}: we owe ${client} a reply`, due: t, link, ...ownerOf(cs.owner_id, "Judy") });
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
