import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A project's workflow (docs/workflows.html): every step's state worked out from live data where we can
 * (diary, Xero invoices, reports, the info checklist, email) and from steps ticked by hand.
 * buildWorkflow is pure; loadWorkflow (one project page) and loadWorkflows (the board) gather the facts.
 */
export type StepState = "done" | "now" | "todo" | "skip";
export type Step = { id: string; title: string; state: StepState; note?: string; manual?: boolean; how?: "auto" | "button" | "task" };
/** One plain sentence on where the project is and who it's waiting on. */
export type Status = { text: string; waitingOn: "us" | "client" | "you" | "admin" | "clerk" | null; days?: number; extra?: string[] };
export type Stage = { key: "pricing" | "setup" | "start" | "live" | "closeout"; title: string; steps: Step[]; state: StepState };
export type Current = Stage["key"] | "lost" | "complete";
export type Workflow = { stages: Stage[]; current: Current; ticked: string[]; status: Status; quiet: boolean };

export type WorkflowProject = {
  id: string; stage: string; is_dfe: boolean | null; dfe_evidence: string | null; created_at: string; stage_changed_at: string | null;
  clerk_id: string | null; clerk_status: string | null; po_number: string | null; drive_folder_id: string | null; lost_reason: string | null;
  next_action?: string | null; with_whom?: string | null; next_action_due?: string | null; start_date?: string | null;
  clerk_me_id?: string | null; clerk_me_status?: string | null;
};
export const WORKFLOW_COLUMNS = "id,stage,is_dfe,dfe_evidence,created_at,stage_changed_at,clerk_id,clerk_status,po_number,drive_folder_id,lost_reason,next_action,with_whom,next_action_due,start_date,clerk_me_id,clerk_me_status";

type ManualStep = { step: string; done_at: string; done_by: string | null; note: string | null };
type Facts = {
  steps: ManualStep[];
  info: { item: string; requested_on: string | null; received_on: string | null }[];
  visits?: { last_visit: string | null; visits: number; charged_visits: number; clerk_names: string[] | null };
  reports?: { last_report: string | null; reports: number };
  invoices: { issued: string | null; amount_due: number | null; status: string | null }[]; // newest first
  drafts?: { number: string | null; issued: string | null; subtotal: number | null }[]; // draft invoices in Xero, not sent
  clerkName?: string | null;
  clerkMeName?: string | null;
  mePlanned?: boolean;      // the cost sheet plans M&E days
  hasContacts: boolean;
  goAhead?: { happened_at: string; who: string | null };
};

const PRICING = ["enquiry", "pricing", "sent"];
const WON = ["won_arranging", "won_preparing"];
const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");
export const daysSince = (d?: string | null) => (d ? Math.max(0, Math.floor((Date.now() - Date.parse(d)) / 864e5)) : undefined);

export function buildWorkflow(p: WorkflowProject, f: Facts): Workflow {
  const manual = new Map(f.steps.map((s) => [s.step, s]));
  const by = (id: string) => { const m = manual.get(id); return m ? `${m.done_by ?? "ticked"}, ${fmt(m.done_at)}` : undefined; };
  // projects already running before workflows existed: hand-only set-up steps count as done
  const legacy = !p.stage_changed_at && !PRICING.includes(p.stage) && !WON.includes(p.stage);
  const info = f.info;

  const live = f.invoices.filter((i) => i.status !== "VOIDED" && i.status !== "DELETED");
  const outstanding = live.reduce((a, i) => a + Number(i.amount_due ?? 0), 0);
  const clerkNames = (f.visits?.clerk_names ?? []).slice(0, 3);
  const infoIn = info.filter((i) => i.received_on).length;
  const poItem = info.find((i) => /\bPO\b/.test(i.item));

  const pastPricing = !PRICING.includes(p.stage);
  const step = (id: string, title: string, done: boolean, note?: string, opts: Partial<Step> = {}): Step =>
    ({ id, title, state: done || manual.has(id) ? "done" : "todo", note: done ? note : by(id) ?? note, ...opts });

  const pricing: Step[] = [
    step("P1", "Request to price received", true, p.stage_changed_at ? fmt(p.created_at) : undefined, { how: "auto" }),
    { ...step("P2", "DfE or not", p.is_dfe != null, undefined, { how: "auto" }),
      note: p.is_dfe == null && p.dfe_evidence?.startsWith("Unsure") ? "Question waiting for you" : p.is_dfe == null ? undefined : p.is_dfe ? "DfE" : "Not DfE" },
    step("P3", "Cost proposal sent", p.stage === "sent" || pastPricing, undefined, { manual: true, how: "button" }),
    step("P4", "Client replied", pastPricing, undefined, { manual: true, how: "auto" }),
    step("P5", "Won or lost", pastPricing, !pastPricing ? undefined : p.stage === "lost" ? `Lost${p.lost_reason ? `: ${p.lost_reason}` : ""}` : "Won", { how: "button" }),
  ];

  // most jobs have an M&E clerk too: DfE jobs, ones with M&E days in the cost sheet, or one already named
  const meNeeded = !!p.clerk_me_id || p.clerk_me_status === "finding" || (p.clerk_me_status !== "none" && (p.is_dfe === true || !!f.mePlanned));
  const s = (id: string, title: string, done: boolean, note?: string, opts: Partial<Step> = {}) =>
    step(id, title, done || (legacy && !!opts.manual), done ? note : legacy && opts.manual ? "Before workflows started" : note, opts);
  const setup: Step[] = [
    s("S1", `${p.is_dfe ? "DfE" : "Standard"} checklist`, info.length > 0, `${info.length} items`, { how: "auto", manual: true }),
    s("S2", "Information requested from client", info.some((i) => i.requested_on), `requested ${fmt(info.find((i) => i.requested_on)?.requested_on)}`, { manual: true, how: "task" }),
    s("S3", "Building clerk of works", !!p.clerk_id || p.clerk_status === "none" || (f.visits?.charged_visits ?? 0) > 0,
      p.clerk_status === "none" && !p.clerk_id ? "None: M&E only" : f.clerkName ?? (clerkNames.join(", ") || undefined), { how: "button" }),
    ...(meNeeded ? [s("S3M", "M&E clerk of works", !!p.clerk_me_id, f.clerkMeName ?? undefined, { how: "button" })] : []),
    s("S4", "Google Drive folder", !!p.drive_folder_id, "created", { manual: true, how: "auto" }),
    s("S5", "Information received", info.length > 0 && infoIn === info.length, info.length ? `${infoIn} of ${info.length} received` : undefined, { manual: true, how: "auto" }),
    s("S6", "PO number", !!p.po_number || !!poItem?.received_on, p.po_number ?? "received", { manual: true, how: "auto" }),
    s("S7", "Set up in Xero", live.length > 0, "invoiced", { manual: true, how: "auto" }),
    s("S8", "Diary updated", (f.visits?.visits ?? 0) > 0 && (f.hasContacts || legacy), "in the diary", { manual: true, how: "task" }),
    s("S9", "Report tracker", (f.reports?.reports ?? 0) > 0, "in the tracker", { manual: true, how: "task" }),
  ];
  const onSite = ["live", "on_hold", "complete"].includes(p.stage);
  const plannedInDiary = (f.visits?.visits ?? 0) - (f.visits?.charged_visits ?? 0) > 0 || (f.visits?.charged_visits ?? 0) > 0;
  // won and set up, but not on site yet: often weeks or months
  const startSteps: Step[] = [
    step("T1", "Start on site date", !!p.start_date || onSite, p.start_date ? fmt(p.start_date) : undefined, { how: "button" }),
    step("T2", "Clerk booked in the diary", plannedInDiary || onSite, plannedInDiary ? "in the diary" : undefined, { how: "task" }),
    step("T3", "Started on site", onSite, undefined, { how: "button" }),
  ];
  const byId = (id: string) => setup.find((x) => x.id === id);
  if (byId("S3")?.state !== "done" && p.clerk_status === "finding") byId("S3")!.note = "Finding a clerk";
  if (byId("S3M") && byId("S3M")!.state !== "done" && p.clerk_me_status === "finding") byId("S3M")!.note = "Finding an M&E clerk";
  if (byId("S5")?.state !== "done" && info.length) byId("S5")!.note = `${infoIn} of ${info.length} received`;

  const lastVisit = f.visits?.last_visit;
  const lastReport = f.reports?.last_report;
  const lastSent = live[0]?.issued;
  const lastDraft = (f.drafts ?? []).map((d) => d.issued).filter(Boolean).sort().pop() ?? null;
  const lastInv = [lastSent, lastDraft].filter(Boolean).sort().pop() ?? undefined;
  const draftNote = lastDraft && lastDraft === lastInv ? " (draft in Xero, not sent)" : "";
  const liveSteps: Step[] = [
    step("L1", "Site visits", !!lastVisit, `last ${fmt(lastVisit)}`, { how: "auto" }),
    step("L2", "Reports", !!lastReport, `last ${fmt(lastReport)}`, { how: "auto" }),
    step("L3", "Invoiced", !!lastInv, `last ${fmt(lastInv)}${draftNote}`, { how: "auto" }),
  ];

  const prevMonth = new Date(); prevMonth.setDate(1); prevMonth.setMonth(prevMonth.getMonth() - 1);
  const prevMonthStart = prevMonth.toISOString().slice(0, 10);
  const x2 = manual.get("X2");
  // "still going" holds until another whole month passes with no invoice after the answer
  const goingSince = x2?.note === "going" ? x2.done_at.slice(0, 10) : undefined;
  const quiet = p.stage === "live" && !!lastInv && lastInv < prevMonthStart && (!goingSince || goingSince < prevMonthStart);
  const closeout: Step[] = [
    { id: "X1", title: "A month with no invoice", how: "auto", state: quiet || p.stage === "on_hold" || p.stage === "complete" || (x2 && x2.note !== "going") ? "done" : "todo", note: lastInv ? `last invoice ${fmt(lastInv)}` : undefined },
    { id: "X2", title: "Finished, paused or still going?", how: "button", state: x2?.note === "finished" || p.stage === "complete" ? "done" : "todo", note: x2 ? `${x2.note}, ${x2.done_by ?? ""} ${fmt(x2.done_at)}` : p.stage === "on_hold" ? "Paused" : undefined },
    { id: "X3", title: "Paid in full", how: "auto", state: (x2?.note === "finished" || p.stage === "complete") && outstanding <= 0 ? "done" : "todo",
      note: outstanding > 0 ? `£${outstanding.toLocaleString("en-GB", { maximumFractionDigits: 0 })} outstanding` : undefined },
    { id: "X4", title: "Complete", how: "auto", state: p.stage === "complete" ? "done" : "todo" },
  ];

  const setupDone = p.stage === "won_preparing" || setup.every((x) => x.state === "done");
  const current: Current =
    p.stage === "lost" ? "lost" : p.stage === "complete" ? "complete" : PRICING.includes(p.stage) ? "pricing" : WON.includes(p.stage) ? (setupDone ? "start" : "setup")
      : p.stage === "on_hold" || quiet || (x2 && x2.note !== "going") ? "closeout" : "live";
  const order = ["pricing", "setup", "start", "live", "closeout"] as const;
  const idx = current === "lost" ? 0 : current === "complete" ? 5 : order.indexOf(current);
  const stages: Stage[] = [
    { key: "pricing", title: "Pricing", steps: pricing, state: "todo" },
    { key: "setup", title: "Set-up", steps: setup, state: "todo" },
    { key: "start", title: "Waiting to start", steps: startSteps, state: "todo" },
    { key: "live", title: "Live", steps: liveSteps, state: "todo" },
    { key: "closeout", title: "Close-out", steps: closeout, state: "todo" },
  ];
  stages.forEach((st, i) => {
    st.state = current === "lost" ? (i === 0 ? "done" : "skip") : i < idx ? "done" : i === idx ? "now" : "todo";
    // the first unfinished step of the current stage is the one we're waiting on
    if (st.state === "now") { const first = st.steps.find((x) => x.state === "todo"); if (first) first.state = "now"; }
  });
  if (current === "lost") stages.slice(1).forEach((st) => st.steps.forEach((x) => (x.state = "skip")));

  // ---- the written status
  const ago = (n?: number) => (n == null ? "" : n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`);
  const money = (n: number) => `£${n.toLocaleString("en-GB", { maximumFractionDigits: 0 })}`;
  const missing = info.filter((i) => !i.received_on);
  const asked = info.filter((i) => i.requested_on).map((i) => i.requested_on as string).sort()[0];
  const list = (xs: string[]) => (xs.length <= 3 ? xs.join(", ") : `${xs.slice(0, 3).join(", ")} and ${xs.length - 3} more`);
  const changed = p.stage_changed_at; // null for projects imported before workflows: date unknown
  const waitingStep = stages.flatMap((st) => st.steps).find((x) => x.state === "now");
  const replied = manual.get("P4");
  let status: Status;
  if (current === "lost") status = { text: `Lost${p.lost_reason ? `: ${p.lost_reason}` : "."}`, waitingOn: null };
  else if (current === "complete") status = { text: "Complete.", waitingOn: null };
  else if (current === "pricing") {
    if (p.is_dfe == null && p.dfe_evidence?.startsWith("Unsure")) status = { text: "Waiting on you to say whether this is a DfE project.", waitingOn: "you" };
    else if (p.stage !== "sent") status = { text: `Waiting on us to price it.${changed ? ` The enquiry came in ${ago(daysSince(changed))}.` : ""}`, waitingOn: "us", days: daysSince(changed) };
    else if (f.goAhead) status = { text: `${f.goAhead.who ?? "The client"} may have given the go-ahead ${ago(daysSince(f.goAhead.happened_at))}. Waiting on you to confirm Won or Lost.`, waitingOn: "you" };
    else if (replied) status = { text: `The client replied ${ago(daysSince(replied.done_at))}. Waiting on you to mark it Won or Lost, or keep talking.`, waitingOn: "you", days: daysSince(replied.done_at) };
    else status = { text: `Proposal sent${changed ? ` ${ago(daysSince(changed))}` : ""}. Waiting on the client to reply.`, waitingOn: "client", days: daysSince(changed) };
  } else if (current === "setup") {
    const id = waitingStep?.id;
    // asked for when the job is about to start, not when it's won (Ronan, 17 Nov 2026)
    if (id === "S1" || id === "S2") status = { text: `Won${changed ? ` ${ago(daysSince(changed))}` : ""}. When it's about to start, press Request information to ask the client for the project information.`, waitingOn: "us", days: daysSince(changed) };
    else if (id === "S3") status = p.clerk_status === "finding"
      ? { text: "Waiting on us to find a building clerk of works.", waitingOn: "us" }
      : { text: "Waiting on us to choose the building clerk of works.", waitingOn: "us" };
    else if (id === "S3M") status = p.clerk_me_status === "finding"
      ? { text: "Waiting on us to find an M&E clerk of works.", waitingOn: "us" }
      : { text: "Waiting on us to choose the M&E clerk of works (or mark the job as having no M&E).", waitingOn: "us" };
    else if (id === "S5" && missing.length) status = { text: `Waiting on the client for ${missing.length} item${missing.length === 1 ? "" : "s"}: ${list(missing.map((i) => i.item))}.${asked ? ` Asked ${ago(daysSince(asked))}.` : " Not asked yet."}`, waitingOn: "client", days: daysSince(asked) };
    else if (id === "S6") status = { text: "Waiting on the client for a PO number.", waitingOn: "client" };
    else if (id === "S8") status = { text: "Waiting on the admin team to add it to the diary (clerk rows, Invoice emails and Report emails tabs).", waitingOn: "admin" };
    else if (id === "S9") status = { text: "Waiting on the admin team to add it to the report tracker.", waitingOn: "admin" };
    else status = { text: waitingStep ? `Setting up. Next: ${waitingStep.title.toLowerCase()}.` : "Set-up done.", waitingOn: waitingStep ? "us" : null };
  } else if (current === "start") {
    const today = new Date().toISOString().slice(0, 10);
    if (!p.start_date) status = { text: "All set up. Waiting to start on site: no start date yet.", waitingOn: "client" };
    else if (p.start_date < today) status = { text: `Was due on site ${fmt(p.start_date)}. Has it started? Press Started on site, or change the date.`, waitingOn: "you", days: daysSince(p.start_date) };
    else if (!plannedInDiary && daysSince(p.start_date) === 0) status = { text: `Starts on site today. The clerk isn't booked in the diary yet.`, waitingOn: "admin" };
    else status = { text: `All set up. Starts on site ${fmt(p.start_date)}${plannedInDiary ? "; the clerk is booked in the diary" : "; the clerk still needs booking in the diary"}.`, waitingOn: plannedInDiary ? null : "admin" };
  } else if (current === "closeout") {
    if (p.stage === "on_hold") status = { text: changed ? `Paused since ${fmt(changed)}.` : "Paused.", waitingOn: null };
    else if (x2?.note === "finished") status = outstanding > 0
      ? { text: `Finished. Waiting on the client to pay ${money(outstanding)}.`, waitingOn: "client" }
      : { text: "Finished and paid.", waitingOn: null };
    else status = { text: `No invoice since ${fmt(lastInv)}. Waiting on you to say whether it's finished, paused or still going.`, waitingOn: "you" };
  } else {
    const who = f.clerkName || f.clerkMeName
      ? [f.clerkName && `${f.clerkName} (building)`, f.clerkMeName && `${f.clerkMeName} (M&E)`].filter(Boolean).join(" and ")
      : clerkNames.slice(0, 2).join(" and ") || undefined;
    status = { text: `Live${who ? ` with ${who}` : ""}. Last visit ${fmt(lastVisit) || "none yet"}, last report ${fmt(lastReport) || "none yet"}, last invoice ${fmt(lastInv) || "none yet"}${draftNote}.`, waitingOn: null };
  }
  const extra: string[] = [];
  if (current === "live" && missing.length) extra.push(`Still waiting on the client for ${list(missing.map((i) => i.item))}.`);
  if (current === "live" && outstanding > 0) extra.push(`${money(outstanding)} outstanding on invoices.`);
  if (p.next_action) extra.push(`Next action: ${p.next_action}${p.with_whom ? ` (with ${p.with_whom})` : ""}${p.next_action_due ? `, due ${fmt(p.next_action_due)}` : ""}.`);
  status.extra = extra;
  return { stages, current, ticked: [...manual.keys()], status, quiet };
}

/** Everything for one project page. */
export async function loadWorkflow(db: SupabaseClient, p: WorkflowProject): Promise<Workflow> {
  return (await loadWorkflows(db, [p])).get(p.id)!;
}

/** Fetch a table for many projects in chunks and pages (PostgREST returns at most 1000 rows a request). */
async function many<T>(db: SupabaseClient, table: string, cols: string, ids: string[], extra?: (q: any) => any): Promise<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    for (let from = 0; ; from += 1000) {
      let q = db.from(table).select(cols).in("project_id", chunk);
      if (extra) q = extra(q);
      const { data, error } = await q.range(from, from + 999);
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}

/** Everything for many projects (the Workflows board), in a fixed number of queries. */
export async function loadWorkflows(db: SupabaseClient, projects: WorkflowProject[]): Promise<Map<string, Workflow>> {
  const ids = projects.map((p) => p.id);
  const clerkIds = [...new Set(projects.flatMap((p) => [p.clerk_id, p.clerk_me_id]).filter(Boolean))] as string[];
  type Row = { project_id: string };
  const [steps, info, visits, reports, invoices, contacts, events, clerks, mePlan, drafts] = await Promise.all([
    many<Row & ManualStep>(db, "project_steps", "project_id,step,done_at,done_by,note", ids),
    many<Row & Facts["info"][number]>(db, "project_info", "project_id,item,requested_on,received_on", ids, (q) => q.order("created_at")),
    many<Row & NonNullable<Facts["visits"]>>(db, "project_visit_summary", "project_id,last_visit,visits,charged_visits,clerk_names", ids),
    many<Row & NonNullable<Facts["reports"]>>(db, "project_report_summary", "project_id,last_report,reports", ids),
    many<Row & Facts["invoices"][number]>(db, "invoices", "project_id,issued,amount_due,status", ids, (q) => q.order("issued", { ascending: false })),
    many<Row>(db, "invoice_contacts", "project_id", ids),
    many<Row & { happened_at: string; who: string | null }>(db, "project_events", "project_id,happened_at,who", ids, (q) => q.eq("kind", "Possible go-ahead").order("happened_at", { ascending: false })),
    clerkIds.length ? db.from("clerks").select("id,name").in("id", clerkIds).then((r) => r.data ?? []) : Promise.resolve([] as { id: string; name: string }[]),
    many<Row>(db, "project_planned_months", "project_id", ids, (q) => q.gt("me", 0)),
    many<Row & { number: string | null; issued: string | null; subtotal: number | null }>(db, "xero_draft_invoices", "project_id,number,issued,subtotal", ids),
  ]);
  const mePlanned = new Set(mePlan.map((m) => m.project_id));
  const group = <T extends Row>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) m.set(r.project_id, [...(m.get(r.project_id) ?? []), r]); return m; };
  const g = { steps: group(steps), info: group(info), visits: group(visits), reports: group(reports), invoices: group(invoices), contacts: group(contacts), events: group(events) };
  const clerkName = new Map(clerks.map((c) => [c.id, c.name]));
  const out = new Map<string, Workflow>();
  for (const p of projects) {
    out.set(p.id, buildWorkflow(p, {
      steps: g.steps.get(p.id) ?? [],
      info: g.info.get(p.id) ?? [],
      visits: g.visits.get(p.id)?.[0],
      reports: g.reports.get(p.id)?.[0],
      invoices: g.invoices.get(p.id) ?? [],
      drafts: drafts.filter((d) => d.project_id === p.id),
      clerkName: p.clerk_id ? clerkName.get(p.clerk_id) : null,
      clerkMeName: p.clerk_me_id ? clerkName.get(p.clerk_me_id) : null,
      mePlanned: mePlanned.has(p.id),
      hasContacts: (g.contacts.get(p.id) ?? []).length > 0,
      goAhead: g.events.get(p.id)?.[0],
    }));
  }
  return out;
}
