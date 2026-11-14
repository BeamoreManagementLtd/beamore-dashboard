import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd, today, daysBetween, CHASE_STATUS } from "@/lib/format";
import { saveProject, addAlias } from "../actions";

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
  const rows = new Map<string, { b: number; me: number; planned: number }>();
  for (const r of (months.data ?? []) as M[]) {
    const x = rows.get(r.month) ?? { b: 0, me: 0, planned: 0 };
    if (r.side === "planned") x.planned += Number(r.days); else if (r.kind === "me") x.me += Number(r.days); else x.b += Number(r.days);
    rows.set(r.month, x);
  }
  const charged = [...rows.values()].reduce((s, x) => s + x.b + x.me, 0);
  const agreed = (Number(p.agreed_days_building ?? 0) + Number(p.agreed_days_me ?? 0)) || null;
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

  return (
    <>
      <Link href="/projects" className="small">← Projects</Link>
      <div className="head">
        <div>
          <h1>{p.display_name}</h1>
          <p>{(p.clients as unknown as { name: string } | null)?.name ?? "No client yet"}{p.proposal_folder ? ` · ${p.proposal_folder}` : ""}</p>
        </div>
      </div>

      <div className="tiles">
        <div className="tile"><span className="label">Agreed days</span><span className="big">{agreed ?? "—"}</span>
          {agreed ? <span className="sub">{p.agreed_days_building ?? 0} bldg · {p.agreed_days_me ?? 0} M&amp;E</span> : <span className="sub">not set</span>}</div>
        <div className={`tile ${agreed && charged > agreed ? "alert" : ""}`}><span className="label">Charged (2026 diary)</span><span className="big">{charged}</span>
          {agreed ? <span className="sub">{charged > agreed ? `${charged - agreed} over` : `${agreed - charged} left`}</span> : null}</div>
        <div className="tile"><span className="label">This month: planned / charged</span><span className="big">{thisMonth?.planned ?? 0} / {(thisMonth?.b ?? 0) + (thisMonth?.me ?? 0)}</span></div>
        <div className={`tile ${owed ? "alert" : ""}`}><span className="label">Outstanding invoices</span><span className="big">{gbp(owed)}</span><span className="sub">{invoices?.length ?? 0} invoice{invoices?.length === 1 ? "" : "s"}</span></div>
      </div>

      <div className="grid2">
        <section className="panel">
          <h2>Days by month</h2>
          {!rows.size ? <p className="empty">No diary days yet.</p> : (
            <table>
              <thead><tr><th>Month</th><th className="num">Planned</th><th className="num">Building</th><th className="num">M&amp;E</th><th className="num">Charged</th></tr></thead>
              <tbody>{[...rows].map(([m, x]) => (
                <tr key={m}><td>{label(m)}</td><td className="num">{x.planned || "—"}</td><td className="num">{x.b || "—"}</td><td className="num">{x.me || "—"}</td><td className="num"><b>{x.b + x.me || "—"}</b></td></tr>
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
            <div className="field"><label htmlFor="ab">Agreed building days</label><input id="ab" name="agreed_days_building" type="number" step="0.5" defaultValue={p.agreed_days_building ?? ""} /></div>
            <div className="field"><label htmlFor="am">Agreed M&amp;E days</label><input id="am" name="agreed_days_me" type="number" step="0.5" defaultValue={p.agreed_days_me ?? ""} /></div>
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
