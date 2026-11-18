import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd, today, CHASE_STATUS } from "@/lib/format";

type Chase = { status: string; next_action: string | null; next_action_due: string | null; promised_date: string | null; with_whom: string | null };
type Inv = {
  id: string; number: string; reference: string | null; issued: string | null; due: string | null; total: number | null; amount_due: number; project_id: string | null; client_id: string | null;
  clients: { name: string } | null; projects: { name: string; display_name: string | null } | null;
  chase_state: Chase | Chase[] | null;
};
const BANDS = [["Not due yet", -Infinity, 0], ["1–30 days", 1, 30], ["31–60", 31, 60], ["61–90", 61, 90], ["Over 90", 91, Infinity]] as const;
const daysLate = (due: string | null, t: string) => (due ? Math.round((Date.parse(t) - Date.parse(due)) / 864e5) : 0);
// One line per company: Xero has several contacts for some (Mott MacDonald Ltd, "Mott MacDonald - Manchester", …).
// The company is the name before " - ", without Ltd / Limited / LLP.
const company = (n: string) => n.split(" - ")[0].replace(/\s+(ltd\.?|limited|llp|plc)$/i, "").trim();
const contactName = (i: Inv) => i.clients?.name ?? "No client on the invoice";
const job = (i: Inv) => i.projects?.display_name ?? i.projects?.name ?? i.reference ?? "";
const chaseOf = (i: Inv) => (Array.isArray(i.chase_state) ? i.chase_state[0] : i.chase_state) ?? null;
const pill = (c: Chase | null) => {
  const [tone, label] = CHASE_STATUS[c?.status ?? "new"] ?? ["muted", c?.status ?? ""];
  return <span className={`pill ${tone}`}>{label}</span>;
};
const lateCell = (d: number) => <td className="num">{d > 0 ? <span className={d > 60 ? "neg" : ""}>{d}</span> : <span className="muted">not yet</span>}</td>;
const monthLabel = (ym: string) => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric" });

/**
 * Who owes Beamore what (Ronan, 18 Nov 2026: "a breakdown of which company owes what and who", then "more information
 * about who's overdue … a list of all the overdue invoices"): headline numbers, one line per company (Xero contacts of
 * the same company combined) with what's overdue and how late, every overdue invoice with where its chase has got to,
 * what falls due in the next 30 days, and what was invoiced each month and how much of it is still unpaid.
 */
export async function OwedBreakdown() {
  const db = await createClient();
  const t = today();
  const yearAgo = new Date(Date.parse(t) - 365 * 864e5).toISOString().slice(0, 10);
  const sel = "id,number,reference,issued,due,total,amount_due,project_id,client_id,clients(name),projects(name,display_name),chase_state(status,next_action,next_action_due,promised_date,with_whom)";
  const [{ data: invs }, { data: contacts }, { data: issuedRows }] = await Promise.all([
    db.from("invoices").select(sel).gt("amount_due", 0).order("due").limit(2000),
    db.from("invoice_contacts").select("project_id,client_id,to_emails"),
    db.from("invoices").select("issued,total,amount_due,status").gte("issued", yearAgo).limit(5000),
  ]);
  const rows = (invs ?? []) as unknown as Inv[];
  if (!rows.length) return null;

  // the last time each overdue invoice was chased (emails read from Gmail, Xero reminders, notes by the team)
  const overdueRows = rows.filter((i) => daysLate(i.due, t) > 0).sort((a, b) => daysLate(b.due, t) - daysLate(a.due, t));
  const lastChased = new Map<string, string>();
  for (let k = 0; k < overdueRows.length; k += 200) {
    const { data: ev } = await db.from("chase_events").select("invoice_id,happened_at").in("invoice_id", overdueRows.slice(k, k + 200).map((i) => i.id));
    for (const e of ev ?? []) if ((lastChased.get(e.invoice_id) ?? "") < e.happened_at) lastChased.set(e.invoice_id, e.happened_at);
  }

  const to = (i: Inv) => {
    const c = (contacts ?? []).find((x) => x.project_id && x.project_id === i.project_id) ?? (contacts ?? []).find((x) => !x.project_id && x.client_id && x.client_id === i.client_id);
    return ((c?.to_emails ?? []) as string[]).join(", ");
  };

  type Co = { name: string; total: number; overdue: number; overdueCount: number; bands: number[]; oldest: number; invs: Inv[]; contacts: Map<string, number> };
  const byCo = new Map<string, Co>();
  for (const i of rows) {
    const name = company(contactName(i));
    const x: Co = byCo.get(name) ?? { name, total: 0, overdue: 0, overdueCount: 0, bands: BANDS.map(() => 0), oldest: 0, invs: [], contacts: new Map() };
    const late = daysLate(i.due, t), amt = Number(i.amount_due);
    x.contacts.set(contactName(i), (x.contacts.get(contactName(i)) ?? 0) + amt);
    x.total += amt;
    if (late > 0) { x.overdue += amt; x.overdueCount++; }
    x.bands[BANDS.findIndex(([, lo, hi]) => late >= lo && late <= hi)] += amt;
    x.oldest = Math.max(x.oldest, late); x.invs.push(i);
    byCo.set(name, x);
  }
  const cos = [...byCo.values()].sort((a, b) => b.total - a.total);
  const all = cos.reduce((s, c) => s + c.total, 0), late = cos.reduce((s, c) => s + c.overdue, 0);
  const bandTotals = BANDS.map((_, k) => cos.reduce((s, c) => s + c.bands[k], 0));
  const bar = (v: number, k: number) => (v ? <td key={k} className="num" style={{ color: k >= 3 ? "var(--bad)" : k >= 1 ? "var(--warn)" : undefined }}>{gbp(v)}</td> : <td key={k} className="num muted">–</td>);

  // headline numbers
  const avgLate = late ? overdueRows.reduce((s, i) => s + daysLate(i.due, t) * Number(i.amount_due), 0) / late : 0;
  const byStatus = new Map<string, { n: number; v: number }>();
  for (const i of overdueRows) {
    const s = chaseOf(i)?.status ?? "new";
    const x = byStatus.get(s) ?? { n: 0, v: 0 };
    x.n++; x.v += Number(i.amount_due); byStatus.set(s, x);
  }
  const in30 = new Date(Date.parse(t) + 30 * 864e5).toISOString().slice(0, 10);
  const dueSoon = rows.filter((i) => i.due && i.due >= t && i.due <= in30);
  const dueSoonTotal = dueSoon.reduce((s, i) => s + Number(i.amount_due), 0);
  const over90 = bandTotals[4];

  // invoiced each month (last 12) and how much of it is still unpaid
  const months = new Map<string, { inv: number; n: number; unpaid: number }>();
  for (const r of issuedRows ?? []) {
    if (!r.issued || /void|deleted/i.test(r.status ?? "")) continue;
    const m = r.issued.slice(0, 7);
    const x = months.get(m) ?? { inv: 0, n: 0, unpaid: 0 };
    x.inv += Number(r.total ?? 0); x.n++; x.unpaid += Number(r.amount_due ?? 0);
    months.set(m, x);
  }
  const monthRows = [...months].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12);
  const maxInv = Math.max(1, ...monthRows.map(([, x]) => x.inv));

  return (
    <>
      <div className="tiles">
        <div className="tile r"><span className="label">Overdue</span><span className="big">{gbp(late)}</span><span className="sub">{overdueRows.length} invoices · {cos.filter((c) => c.overdue > 0).length} companies</span></div>
        <div className="tile r"><span className="label">Over 90 days late</span><span className="big">{gbp(over90)}</span><span className="sub">{overdueRows.filter((i) => daysLate(i.due, t) > 90).length} invoices</span></div>
        <div className="tile r"><span className="label">Average days late</span><span className="big">{Math.round(avgLate)}</span><span className="sub">weighted by amount</span></div>
        <div className="tile r"><span className="label">Due in the next 30 days</span><span className="big">{gbp(dueSoonTotal)}</span><span className="sub">{dueSoon.length} invoices</span></div>
      </div>

      <section className="panel">
        <h2>Who owes us</h2>
        <p className="small muted">{gbp(all)} on {rows.length} unpaid invoices from {cos.length} companies; {gbp(late)} of it overdue. From Xero, updated hourly. Where a company has several Xero contacts (Mott MacDonald has one per office) they’re added together. Click a company to see its invoices, the job, where the chase has got to and who they go to.</p>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Company</th><th className="num">Owed</th><th className="num">Overdue</th>{BANDS.map(([l]) => <th key={l} className="num">{l}</th>)}<th className="num">Oldest</th></tr></thead>
          <tbody>
            {cos.map((c) => (
              <tr key={c.name}>
                <td>
                  <details>
                    <summary style={{ cursor: "pointer" }}><b>{c.contacts.size > 1 ? c.name : contactName(c.invs[0])}</b> <span className="muted small">· {c.invs.length} invoice{c.invs.length === 1 ? "" : "s"}{c.contacts.size > 1 ? ` · ${c.contacts.size} Xero contacts` : ""}</span></summary>
                    {c.contacts.size > 1 && (
                      <p className="small muted" style={{ margin: "6px 0 0" }}>
                        {[...c.contacts].sort((a, b) => b[1] - a[1]).map(([n, v]) => `${n} ${gbp(v)}`).join(" · ")}
                      </p>
                    )}
                    <table className="small" style={{ marginTop: 6 }}>
                      <thead><tr><th>Invoice</th>{c.contacts.size > 1 && <th>Xero contact</th>}<th>Job</th><th>Due</th><th className="num">Days late</th><th className="num">Owed</th><th>Chase</th><th>Goes to</th></tr></thead>
                      <tbody>{c.invs.map((i) => {
                        const d = daysLate(i.due, t);
                        return (
                          <tr key={i.number}>
                            <td><Link href={`/invoices/${encodeURIComponent(i.number)}`}>{i.number}</Link></td>
                            {c.contacts.size > 1 && <td>{contactName(i)}</td>}
                            <td>{job(i)}</td>
                            <td>{i.due ? fd(i.due) : ""}</td>
                            {lateCell(d)}
                            <td className="num">{gbp(i.amount_due)}</td>
                            <td>{d > 0 ? pill(chaseOf(i)) : null}</td>
                            <td className="muted" style={{ maxWidth: 260 }}>{to(i)}</td>
                          </tr>
                        );
                      })}</tbody>
                    </table>
                  </details>
                </td>
                <td className="num"><b>{gbp(c.total)}</b></td>
                <td className="num">{c.overdue ? <span className="neg">{gbp(c.overdue)}</span> : <span className="muted">–</span>}{c.overdueCount ? <span className="muted small"> ({c.overdueCount})</span> : null}</td>
                {c.bands.map(bar)}
                <td className="num">{c.oldest > 0 ? <span className={c.oldest > 60 ? "neg" : ""}>{c.oldest} days</span> : <span className="muted">–</span>}</td>
              </tr>
            ))}
            <tr><td><b>Total</b></td><td className="num"><b>{gbp(all)}</b></td><td className="num"><b>{gbp(late)}</b></td>{bandTotals.map(bar)}<td /></tr>
          </tbody>
        </table></div>
      </section>

      <section className="panel">
        <h2>Overdue invoices</h2>
        <p className="small muted">
          All {overdueRows.length} overdue invoices, latest first.{" "}
          {Object.keys(CHASE_STATUS).filter((s) => byStatus.has(s)).map((s, k) => (
            <span key={s}>{k ? " · " : ""}{CHASE_STATUS[s][1]}: <b>{gbp(byStatus.get(s)!.v)}</b> ({byStatus.get(s)!.n})</span>
          ))}
        </p>
        <div className="tbl-wrap"><table className="small">
          <thead><tr><th>Invoice</th><th>Company</th><th>Job</th><th>Due</th><th className="num">Days late</th><th className="num">Owed</th><th>Chase</th><th>Last chased</th><th>Next step</th></tr></thead>
          <tbody>{overdueRows.map((i) => {
            const c = chaseOf(i), lc = lastChased.get(i.id);
            const next = [c?.promised_date ? `Promised ${fd(c.promised_date)}` : "", c?.next_action ?? "", c?.next_action_due ? `by ${fd(c.next_action_due)}` : ""].filter(Boolean).join(" · ");
            return (
              <tr key={i.number}>
                <td><Link href={`/invoices/${encodeURIComponent(i.number)}`}>{i.number}</Link></td>
                <td>{company(contactName(i))}</td>
                <td>{job(i)}</td>
                <td>{i.due ? fd(i.due) : ""}</td>
                {lateCell(daysLate(i.due, t))}
                <td className="num">{gbp(i.amount_due)}</td>
                <td>{pill(c)}</td>
                <td>{lc ? fd(lc.slice(0, 10)) : <span className="neg">never</span>}</td>
                <td className="muted">{next}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      </section>

      <section className="panel">
        <h2>Due in the next 30 days</h2>
        {!dueSoon.length ? <p className="muted small">Nothing falls due in the next 30 days.</p> : (
          <>
            <p className="small muted">{gbp(dueSoonTotal)} on {dueSoon.length} invoices should come in by {fd(in30)} if paid on time.</p>
            <div className="tbl-wrap"><table className="small">
              <thead><tr><th>Due</th><th>Invoice</th><th>Company</th><th>Job</th><th className="num">Owed</th></tr></thead>
              <tbody>{dueSoon.map((i) => (
                <tr key={i.number}>
                  <td>{fd(i.due!)}</td>
                  <td><Link href={`/invoices/${encodeURIComponent(i.number)}`}>{i.number}</Link></td>
                  <td>{company(contactName(i))}</td>
                  <td>{job(i)}</td>
                  <td className="num">{gbp(i.amount_due)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Invoiced each month</h2>
        <p className="small muted">What was invoiced each month (inc. VAT) over the last year, and how much of each month’s invoices is still unpaid.</p>
        <div className="tbl-wrap"><table className="small">
          <thead><tr><th>Month</th><th className="num">Invoices</th><th className="num">Invoiced</th><th style={{ width: "35%" }}></th><th className="num">Still unpaid</th><th className="num">Paid</th></tr></thead>
          <tbody>{monthRows.map(([m, x]) => (
            <tr key={m}>
              <td>{monthLabel(m)}</td>
              <td className="num">{x.n}</td>
              <td className="num">{gbp(x.inv)}</td>
              <td>
                <div style={{ display: "flex", height: 10, width: `${(x.inv / maxInv) * 100}%`, minWidth: 2, borderRadius: 3, overflow: "hidden", background: "var(--good)" }} title={`${gbp(x.inv - x.unpaid)} paid, ${gbp(x.unpaid)} unpaid`}>
                  <div style={{ marginLeft: "auto", width: `${x.inv ? (x.unpaid / x.inv) * 100 : 0}%`, background: "var(--warn)" }} />
                </div>
              </td>
              <td className="num">{x.unpaid ? gbp(x.unpaid) : <span className="muted">–</span>}</td>
              <td className="num">{x.inv ? `${Math.round(((x.inv - x.unpaid) / x.inv) * 100)}%` : "–"}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="small muted">Green is paid, amber is still owed.</p>
      </section>
    </>
  );
}
