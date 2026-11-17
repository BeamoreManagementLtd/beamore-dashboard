import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd, today, daysBetween, CHASE_STATUS } from "@/lib/format";
import { loadWorkflow } from "@/lib/workflow";
import { WorkflowPanel } from "./workflow-panel";
import { FindClerk } from "./find-clerk";
import { EmailLists } from "./email-lists";
import { ClientPicker } from "./client-picker";
import { guessFolderKind } from "@/lib/folder-kinds";
import { saveProject, addAlias, setDfe, startInfoChecklist, addInfoItem, requestOutstanding, setInfoReceived, removeInfoItem, addProjectEvent } from "../actions";
const r1 = (n: number) => Math.round(n * 10) / 10;

export const dynamic = "force-dynamic";

const STAGES: [string, string][] = [
  ["enquiry", "Enquiry"], ["pricing", "Pricing"], ["sent", "Sent – awaiting reply"], ["won_arranging", "Won – arranging clerk"],
  ["won_preparing", "Won – preparing to start"], ["live", "Live"], ["on_hold", "On hold"], ["lost", "Lost"], ["complete", "Complete"],
];
const label = (m: string) => new Date(m + "T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

export default async function Project({ params }: { params: Promise<{ id: string }> }) {
  const me = await requireProfile();
  const { id } = await params;
  const db = await createClient();
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const { data: p } = await db.from("projects").select("*,clients(name)").eq("id", id).maybeSingle();
  if (!p) notFound();
  const [wf, { data: clerkList }, { data: plan }, { data: draftInv }] = await Promise.all([loadWorkflow(db, p), db.from("clerks").select("id,name").eq("active", true).order("name"),
    db.from("project_planned_months").select("month,building,me").eq("project_id", p.id).order("month"),
    db.from("xero_draft_invoices").select("number,issued,subtotal,contact").eq("project_id", p.id).order("issued")]);
  const [{ data: info }, { data: pevents }] = await Promise.all([
    db.from("project_info").select("id,item,requested_on,received_on,hint,hint_thread,auto").eq("project_id", id).order("created_at"),
    db.from("project_events").select("id,happened_at,source,kind,who,body").eq("project_id", id).order("happened_at", { ascending: false }).limit(40),
  ]);
  const [months, { data: invoices }, { data: onSite }, { data: queue }, { data: log }, { data: contacts }, { data: staff }, { data: fin }] = await Promise.all([
    db.rpc("project_month_days", { p: id }),
    db.from("invoices").select("id,number,reference,due,amount_due,days_building,days_me,chase_state(status,next_action,next_action_due)").eq("project_id", id).gt("amount_due", 0).order("due"),
    db.from("diary_visits").select("clerk_id,side,days,clerks(name)").eq("project_id", id).gte("visit_date", monthStart),
    db.from("report_queue").select("report_name,due,checker").eq("project_id", id).order("due"),
    db.from("report_log").select("report_date,working_days,status,clerk_name").eq("project_id", id).order("report_date", { ascending: false }).limit(8),
    db.from("invoice_contacts").select("label,to_emails,cc_emails,notes").or(`project_id.eq.${id}${p.client_id ? `,client_id.eq.${p.client_id}` : ""}`),
    db.from("profiles").select("id,full_name,email").order("full_name"),
    me.role === "director" ? db.from("project_finance").select("*").eq("project_id", id).maybeSingle() : Promise.resolve({ data: null }),
  ]);

  // months: charged/planned by kind
  type M = { month: string; kind: string; side: string; days: number };
  const rows = new Map<string, { b: number; me: number; planned: number; plan: number }>();
  // the plan from the latest cost sheet covers every month of the job, including ones not in the diary yet
  for (const m of plan ?? []) rows.set(m.month, { b: 0, me: 0, planned: 0, plan: Number(m.building) + Number(m.me) });
  for (const r of (months.data ?? []) as M[]) {
    const x = rows.get(r.month) ?? { b: 0, me: 0, planned: 0, plan: 0 };
    if (r.side === "planned") x.planned += Number(r.days); else if (r.kind === "me") x.me += Number(r.days); else x.b += Number(r.days);
    rows.set(r.month, x);
  }
  const sorted = [...rows].sort(([a], [b]) => a.localeCompare(b));
  const charged = [...rows.values()].reduce((s, x) => s + x.b + x.me, 0);
  const planTotal = (plan ?? []).reduce((s, m) => s + Number(m.building) + Number(m.me), 0);
  // agreed days come from the cost schedule when there is one (Ronan, 17 Nov 2026: the box said "not set" on jobs
  // whose inspection schedule shows every day); the figures typed in by hand only when there's no schedule
  const planB = r1((plan ?? []).reduce((s, m) => s + Number(m.building), 0)), planM = r1((plan ?? []).reduce((s, m) => s + Number(m.me), 0));
  const fromPlan = planTotal > 0;
  // Ronan: "the agreed number of days are the days on the cost schedules that I send to people" — nothing else
  const agreedB = planB, agreedM = planM;
  const agreed = r1(agreedB + agreedM) || null;
  // planned up to the end of this month, to compare with what's been charged so far
  const planToDate = r1((plan ?? []).filter((m) => m.month <= monthStart).reduce((s, m) => s + Number(m.building) + Number(m.me), 0));
  const { data: allClients } = await db.from("clients").select("id,name").order("name");
  const { data: agreedWork } = await db.from("workload_agreed").select("days,per,date_from,date_to,clerks(name)").eq("project_id", id);
  const thisMonth = rows.get(monthStart);
  const clerks = new Map<string, { planned: number; charged: number }>();
  for (const v of onSite ?? []) {
    const n = (v.clerks as unknown as { name: string } | null)?.name ?? "Unknown";
    const c = clerks.get(n) ?? { planned: 0, charged: 0 };
    c[v.side as "planned" | "charged"] += Number(v.days);
    clerks.set(n, c);
  }
  const contact = (contacts ?? [])[0];
  const save = saveProject.bind(null, id);
  const owed = (invoices ?? []).reduce((s, i) => s + Number(i.amount_due), 0);
  // ---- project information from the client: who has the next move
  const items = info ?? [];
  const waitingOn = items.filter((i) => i.requested_on && !i.received_on);
  const notAsked = items.filter((i) => !i.requested_on && !i.received_on);
  const oldest = waitingOn.map((i) => i.requested_on!).sort()[0];
  const infoBanner = !items.length ? null
    : waitingOn.length ? { tone: oldest && daysBetween(oldest, t) > 7 ? "bad" : "warn", title: "Waiting on the client", text: `for ${waitingOn.map((i) => i.item).join(", ")} (asked ${fd(oldest)}${daysBetween(oldest, t) > 7 ? `, ${daysBetween(oldest, t)} days ago: chase` : ""}).` }
    : notAsked.length ? { tone: "bad", title: "Ball is in our court.", text: `${notAsked.length} item${notAsked.length > 1 ? "s" : ""} not asked for yet: ${notAsked.map((i) => i.item).join(", ")}.` }
    : { tone: "good", title: "All project information received.", text: "" };
  const look = (kind: string) => kind === "Email received" || kind === "Info received" || kind === "Possible go-ahead" ? "in" : kind === "Email sent" || kind === "Info requested" ? "out" : kind === "Phone call" || kind === "Note" ? "team" : "xero";

  return (
    <>
      <Link href="/projects" className="small">← Projects</Link>
      <div className="head">
        <div>
          <h1>{p.display_name}</h1>
          <p><ClientPicker projectId={p.id} current={p.client_id ? { id: p.client_id, name: (p.clients as unknown as { name: string } | null)?.name ?? "" } : null} clients={allClients ?? []} />{p.proposal_folder ? ` · ${p.proposal_folder}` : ""}{" "}
            {p.is_dfe === true && <span className="pill warn" title={p.dfe_evidence ?? ""}>DfE project</span>}
            {p.is_dfe === false && <span className="pill neutral" title={p.dfe_evidence ?? ""}>Not DfE</span>}</p>
          {p.is_dfe != null && <div className="small muted">{p.is_dfe ? `Why DfE: ${p.dfe_evidence}` : p.dfe_evidence} · <form action={setDfe.bind(null, p.id, !p.is_dfe)} style={{ display: "inline" }}><button className="linklike" type="submit">{p.is_dfe ? "Not DfE?" : "Actually DfE?"}</button></form></div>}
          {p.is_dfe == null && p.dfe_evidence?.startsWith("Unsure") && <div className="callout warn">Is this a DfE project? {p.dfe_evidence.replace(/^Unsure: /, "")}. <form action={setDfe.bind(null, p.id, true)} style={{ display: "inline" }}><button className="btn" type="submit">Yes, DfE</button></form> <form action={setDfe.bind(null, p.id, false)} style={{ display: "inline" }}><button className="btn" type="submit">No</button></form></div>}
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><span className="label">Agreed days</span><span className="big">{agreed ?? "—"}</span>
          {agreed ? <span className="sub">{agreedB} bldg · {agreedM} M&amp;E · from the cost schedule</span>
            : agreedWork?.length ? <span className="sub">{agreedWork.map((a) => `${(a.clerks as unknown as { name: string } | null)?.name ?? ""} ${a.days} day${Number(a.days) === 1 ? "" : "s"} a ${a.per}${a.date_to ? ` to ${fd(a.date_to)}` : ""}`).join("; ")} (agreed)</span>
            : <span className="sub">not set: no cost schedule found</span>}</div>
        <div className={`tile ${fromPlan && charged > planToDate + 2 ? "alert" : ""}`}><span className="label">Charged so far (diary)</span><span className="big">{r1(charged)}</span>
          {fromPlan ? <span className="sub">{planToDate} planned to the end of this month · {charged > planToDate ? `${r1(charged - planToDate)} ahead of the plan` : charged < planToDate ? `${r1(planToDate - charged)} behind the plan` : "on plan"} · {r1(Math.max(0, planTotal - charged))} left</span>
            : agreed ? <span className="sub">{charged > agreed ? `${r1(charged - agreed)} over` : `${r1(agreed - charged)} left`}</span> : null}</div>
        <div className="tile"><span className="label">This month: planned / charged</span><span className="big">{thisMonth?.planned ?? 0} / {(thisMonth?.b ?? 0) + (thisMonth?.me ?? 0)}</span></div>
        <div className={`tile ${owed ? "alert" : ""}`}><span className="label">Outstanding invoices</span><span className="big">{gbp(owed)}</span><span className="sub">{invoices?.length ?? 0} invoice{invoices?.length === 1 ? "" : "s"}</span></div>
      </div>

      <WorkflowPanel projectId={p.id} stages={wf.stages} current={wf.current} clerks={clerkList ?? []} ticked={new Set(wf.ticked)} status={wf.status} folder={{ id: p.drive_folder_id ?? null, kind: p.folder_kind ?? guessFolderKind(p) }} startDate={p.start_date ?? null} />

      {((p.clerk_status === "finding" && !p.clerk_id) || (p.clerk_me_status === "finding" && !p.clerk_me_id)) && <FindClerk db={db} project={p} today={t} />}

      {(() => {
        const d = (p.details ?? {}) as Record<string, string>;
        const cname = (id: string | null) => (clerkList ?? []).find((c) => c.id === id)?.name;
        const rowsD: [string, string | null | undefined][] = [
          ["Building clerk of works", cname(p.clerk_id) ?? (p.clerk_status === "finding" ? "Finding one" : null)],
          ["M&E clerk of works", cname(p.clerk_me_id) ?? (p.clerk_me_status === "finding" ? "Finding one" : p.clerk_me_status === "none" ? "None on this job" : null)],
          ["DfE project number", p.dfe_project_number ?? d.dfe_project_number], ["DfE project director", d.dfe_project_director], ["DfE project manager", d.dfe_project_manager],
          ["Technical adviser", d.ta_name && `${d.ta_name}${d.ta_firm ? ` (${d.ta_firm})` : ""}`], ["Principal contractor", d.principal_contractor && `${d.principal_contractor}${d.pc_project_manager ? `, PM ${d.pc_project_manager}` : ""}${d.pc_project_number && !/tbc|not known/i.test(d.pc_project_number) ? `, no. ${d.pc_project_number}` : ""}`],
          ["Site address", d.site_address], ["PO number", p.po_number],
          ["Inspections / reports", [p.inspection_frequency, p.reporting_frequency].filter(Boolean).join(" / ") || null],
        ];
        const shown = rowsD.filter(([, v]) => v);
        return shown.length ? (
          <section className="panel">
            <h2>Key details</h2>
            <table><tbody>{shown.map(([k, v]) => <tr key={k}><td className="muted small" style={{ width: 190 }}>{k}</td><td>{v}</td></tr>)}</tbody></table>
            {d._file && <p className="small muted">From the diary’s Report emails and Invoice POs tabs, and the newest CoW diary ({d._file}). Updated daily.</p>}
          </section>
        ) : null;
      })()}

      <EmailLists db={db} projectId={p.id} />

      {infoBanner && <p className={`callout ${infoBanner.tone}`}><b>{infoBanner.title}</b> {infoBanner.text}</p>}
      <div className="grid2">
        <section className="panel">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h2>Project information from the client</h2>
            {!!notAsked.length && <form action={requestOutstanding.bind(null, id)}><button className="btn">Mark {notAsked.length} as requested today</button></form>}
          </div>
          {!items.length ? (
            <div className="row">
              <span className="muted small">No checklist yet.</span>
              <form action={startInfoChecklist.bind(null, id, "dfe")}><button className="btn primary">Start DfE checklist</button></form>
              <form action={startInfoChecklist.bind(null, id, "standard")}><button className="btn">Start standard checklist</button></form>
            </div>
          ) : (
            <table><tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{i.item}
                    {!i.received_on && i.hint && <span className="two">Possibly in {i.hint}{i.hint_thread && <> · <a href={`https://mail.google.com/mail/u/0/#all/${i.hint_thread}`} target="_blank" rel="noopener">open ↗</a></>}</span>}</td>
                  <td className="small">{i.received_on ? <span className="pill good">Received {fd(i.received_on)}</span>
                    : i.requested_on ? <span className={`pill ${daysBetween(i.requested_on, t) > 7 ? "bad" : "warn"}`}>Asked {fd(i.requested_on)}</span>
                    : <span className="pill neutral">Not asked yet</span>}</td>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>
                    <form action={setInfoReceived.bind(null, id, i.id, !i.received_on)} style={{ display: "inline" }}><button className="btn sm">{i.received_on ? "Undo" : "Received"}</button></form>{" "}
                    {!i.received_on && <form action={removeInfoItem.bind(null, id, i.id)} style={{ display: "inline" }}><button className="btn sm" title="Not needed for this project">✕</button></form>}
                  </td>
                </tr>
              ))}
            </tbody></table>
          )}
          {!!items.length && (
            <form action={addInfoItem.bind(null, id)} className="row">
              <div className="field"><input name="item" placeholder="Add something else we need, e.g. Fire strategy" /></div>
              <button className="btn">Add</button>
            </form>
          )}
        </section>
        <section className="panel">
          <h2>Project log</h2>
          {!pevents?.length ? <p className="empty">Nothing logged yet.</p> : (
            <ol className="timeline">
              {pevents.map((e) => (
                <li key={e.id}>
                  <span className="when">{fd(e.happened_at)}</span>
                  <span className={`dot ${look(e.kind)}`} />
                  <div>
                    <div className="ev-top"><b>{e.kind}</b><span className="src">{e.source === "team" ? "Logged" : "Dashboard"}</span></div>
                    {e.body && <p>{e.body}</p>}
                    {e.who && <p className="ev-who">By {e.who}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <form action={addProjectEvent.bind(null, id)} className="form">
            <div className="row">
              <div className="field" style={{ flex: "0 1 160px" }}><label htmlFor="pk">What happened</label>
                <select id="pk" name="kind"><option>Phone call</option><option>Email sent</option><option>Email received</option><option>Note</option></select></div>
              <div className="field"><label htmlFor="pb">Details</label><input id="pb" name="body" required placeholder="e.g. Asked Sarah for the programme" /></div>
              <button className="btn primary">Add to log</button>
            </div>
          </form>
        </section>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>Days by month</h2>
          {p.plan_file && (planTotal > 0
            ? <p className="small muted">Plan from {p.plan_file} ({planTotal} days in all). The latest cost sheet is read every morning.</p>
            : <p className="small muted">{p.plan_file}.</p>)}
          {!rows.size ? <p className="empty">No diary days or cost sheet plan yet.</p> : (
            <table>
              <thead><tr><th>Month</th><th className="num" title="From the latest cost sheet">Plan</th><th className="num" title="Grey side of the diary">In diary</th><th className="num">Building</th><th className="num">M&amp;E</th><th className="num">Charged</th></tr></thead>
              <tbody>{sorted.map(([m, x]) => (
                <tr key={m} className={m === monthStart ? "now-row" : ""}><td>{label(m)}</td><td className="num">{x.plan || "—"}</td><td className="num">{x.planned || "—"}</td><td className="num">{x.b || "—"}</td><td className="num">{x.me || "—"}</td>
                  <td className="num"><b className={x.plan && m < monthStart && x.b + x.me > x.plan ? "over" : ""}>{x.b + x.me || "—"}</b></td></tr>
              ))}</tbody>
            </table>
          )}
        </section>

        <form action={save} className="panel form">
          <h2>Where it stands</h2>
          <div className="row">
            <div className="field"><label htmlFor="stage">Stage</label>
              <select id="stage" name="stage" defaultValue={p.stage}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div className="field"><label htmlFor="owner">Beamore owner</label>
              <select id="owner" name="owner_id" defaultValue={p.owner_id ?? ""}><option value="">Unassigned</option>
                {(staff ?? []).map((s) => <option key={s.id} value={s.id}>{s.full_name ?? s.email}</option>)}</select></div>
          </div>
          <div className="field"><label htmlFor="na">Next action</label><input id="na" name="next_action" defaultValue={p.next_action ?? ""} /></div>
          <div className="row">
            <div className="field"><label htmlFor="nd">Next action due</label><input id="nd" name="next_action_due" type="date" defaultValue={p.next_action_due ?? ""} /></div>
          </div>
          <div><button className="btn primary">Save</button> <span className="small muted">Next actions due in the next 2 weeks appear on the due list.</span></div>
        </form>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>On site this month</h2>
          {!clerks.size ? <p className="empty">Nobody in the diary this month.</p> : (
            <table><thead><tr><th>Clerk</th><th className="num">Planned</th><th className="num">Charged</th></tr></thead>
              <tbody>{[...clerks].map(([n, c]) => <tr key={n}><td>{n}</td><td className="num">{c.planned || "—"}</td><td className="num">{c.charged || "—"}</td></tr>)}</tbody></table>
          )}
        </section>
        <section className="panel">
          <h2>Outstanding invoices</h2>
          {!!draftInv?.length && <p className="callout info small">Draft{draftInv.length > 1 ? "s" : ""} in Xero, not sent yet: {draftInv.map((d) => `${d.number} £${Math.round(Number(d.subtotal ?? 0)).toLocaleString("en-GB")} (${d.issued})`).join(", ")}</p>}
          {!invoices?.length ? <p className="empty">Nothing outstanding.</p> : (
            <table><tbody>{invoices.map((i) => {
              const raw = i.chase_state as unknown;
              const cs = (Array.isArray(raw) ? raw[0] : raw) as { status: string; next_action: string | null } | null;
              const [tone, l] = CHASE_STATUS[cs?.status ?? "new"];
              const late = i.due && i.due < t ? daysBetween(i.due, t) : 0;
              return (
                <tr key={i.id}>
                  <td className="mono"><Link href={`/invoices/${encodeURIComponent(i.number)}`}>{i.number}</Link><span className="two">{i.reference}</span></td>
                  <td className="num">{gbp(i.amount_due)}<span className="two">{late ? `${late} days overdue` : `due ${fd(i.due)}`}</span></td>
                  <td>{late ? <span className={`pill ${tone}`}>{l}</span> : <span className="muted small">not due yet</span>}</td>
                </tr>
              );
            })}</tbody></table>
          )}
          {contact && <p className="small muted">Chase contacts: {contact.to_emails.join("; ")}{contact.cc_emails.length ? ` (cc ${contact.cc_emails.length})` : ""}{contact.notes ? ` · ${contact.notes}` : ""}</p>}
        </section>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>Reports</h2>
          {!queue?.length ? <p className="small muted">Nothing waiting to check.</p> : (
            <table><tbody>{queue.map((q, i) => (
              <tr key={i}><td className="small">{q.report_name}</td><td className={q.due && q.due < t ? "neg" : ""}>{fd(q.due)}</td><td>{q.checker === "Unknown" ? <span className="pill bad">No checker</span> : q.checker}</td></tr>
            ))}</tbody></table>
          )}
          {!!log?.length && (
            <>
              <p className="small"><b>Recent turnaround</b></p>
              <table><tbody>{log.map((l, i) => (
                <tr key={i}><td>{fd(l.report_date)}</td><td>{l.clerk_name}</td><td className={`num ${Number(l.working_days) > 2 ? "neg" : ""}`}>{l.working_days ?? "—"} days</td><td className="small muted">{l.status}</td></tr>
              ))}</tbody></table>
            </>
          )}
        </section>
        <section className="panel">
          <h2>Diary spellings</h2>
          <p className="small muted">Names this project goes by in the diary and in Xero references. Add one and the next sync counts its days and invoices here.</p>
          <p>{p.diary_aliases.length ? p.diary_aliases.map((a: string) => <span key={a} className="pill neutral" style={{ marginRight: 6 }}>{a}</span>) : <span className="muted">None yet</span>}</p>
          <form action={addAlias.bind(null, id)} className="row">
            <div className="field"><label htmlFor="al">Add a spelling</label><input id="al" name="alias" placeholder="e.g. StAidans(M&E)" /></div>
            <button className="btn">Add</button>
          </form>
          {me.role === "director" && (
            <>
              <h2 style={{ marginTop: 16 }}>Fees <span className="ronly">Director only</span></h2>
              <p className="small">Quoted fee {gbp(fin?.quoted_fee)} · building rate {gbp(fin?.charge_rate_building)} · M&amp;E rate {gbp(fin?.charge_rate_me)}</p>
            </>
          )}
        </section>
      </div>
    </>
  );
}
