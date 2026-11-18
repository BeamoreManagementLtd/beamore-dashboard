import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd, today, CHASE_STATUS } from "@/lib/format";

type Inv = {
  number: string; reference: string | null; issued: string | null; due: string | null; amount_due: number; project_id: string | null; client_id: string | null;
  clients: { name: string } | null; projects: { name: string; display_name: string | null } | null;
  chase_state: { status: string } | { status: string }[] | null;
};
const BANDS = [["Not due yet", -Infinity, 0], ["1–30 days", 1, 30], ["31–60", 31, 60], ["61–90", 61, 90], ["Over 90", 91, Infinity]] as const;
const daysLate = (due: string | null, t: string) => (due ? Math.round((Date.parse(t) - Date.parse(due)) / 864e5) : 0);

/**
 * Who owes Beamore what (Ronan, 18 Nov 2026: "a breakdown of which company owes what and who"): every client with
 * unpaid invoices, how much and how overdue, and under each one its invoices, the job, where the chase has got to and
 * who the invoices go to (the diary's Invoice emails tab).
 */
export async function OwedBreakdown() {
  const db = await createClient();
  const t = today();
  const [{ data: invs }, { data: contacts }] = await Promise.all([
    db.from("invoices").select("number,reference,issued,due,amount_due,project_id,client_id,clients(name),projects(name,display_name),chase_state(status)").gt("amount_due", 0).order("due").limit(2000),
    db.from("invoice_contacts").select("project_id,client_id,to_emails"),
  ]);
  const rows = (invs ?? []) as unknown as Inv[];
  if (!rows.length) return null;
  const to = (i: Inv) => {
    const c = (contacts ?? []).find((x) => x.project_id && x.project_id === i.project_id) ?? (contacts ?? []).find((x) => !x.project_id && x.client_id && x.client_id === i.client_id);
    return ((c?.to_emails ?? []) as string[]).join(", ");
  };
  const byClient = new Map<string, { name: string; total: number; overdue: number; bands: number[]; oldest: number; invs: Inv[] }>();
  for (const i of rows) {
    const name = i.clients?.name ?? "No client on the invoice";
    const x = byClient.get(name) ?? { name, total: 0, overdue: 0, bands: BANDS.map(() => 0), oldest: 0, invs: [] };
    const late = daysLate(i.due, t), amt = Number(i.amount_due);
    x.total += amt; if (late > 0) x.overdue += amt;
    x.bands[BANDS.findIndex(([, lo, hi]) => late >= lo && late <= hi)] += amt;
    x.oldest = Math.max(x.oldest, late); x.invs.push(i);
    byClient.set(name, x);
  }
  const clients = [...byClient.values()].sort((a, b) => b.total - a.total);
  const all = clients.reduce((s, c) => s + c.total, 0), late = clients.reduce((s, c) => s + c.overdue, 0);
  const bandTotals = BANDS.map((_, k) => clients.reduce((s, c) => s + c.bands[k], 0));
  const bar = (v: number, k: number) => (v ? <td className="num" style={{ color: k >= 3 ? "var(--bad)" : k >= 1 ? "var(--warn)" : undefined }}>{gbp(v)}</td> : <td className="num muted">–</td>);

  return (
    <section className="panel">
      <h2>Who owes us</h2>
      <p className="small muted">{gbp(all)} on {rows.length} unpaid invoices from {clients.length} clients; {gbp(late)} of it overdue. From Xero, updated hourly. Click a client to see its invoices, the job, where the chase has got to and who they go to.</p>
      <div className="tbl-wrap"><table>
        <thead><tr><th>Client</th><th className="num">Owed</th>{BANDS.map(([l]) => <th key={l} className="num">{l}</th>)}<th className="num">Oldest</th></tr></thead>
        <tbody>
          {clients.map((c) => (
            <tr key={c.name}>
              <td>
                <details>
                  <summary style={{ cursor: "pointer" }}><b>{c.name}</b> <span className="muted small">· {c.invs.length} invoice{c.invs.length === 1 ? "" : "s"}</span></summary>
                  <table className="small" style={{ marginTop: 6 }}>
                    <thead><tr><th>Invoice</th><th>Job</th><th>Due</th><th className="num">Days late</th><th className="num">Owed</th><th>Chase</th><th>Goes to</th></tr></thead>
                    <tbody>{c.invs.map((i) => {
                      const d = daysLate(i.due, t);
                      const cs = Array.isArray(i.chase_state) ? i.chase_state[0] : i.chase_state;
                      const [tone, label] = CHASE_STATUS[(cs?.status ?? "new") as keyof typeof CHASE_STATUS] ?? ["muted", cs?.status ?? ""];
                      return (
                        <tr key={i.number}>
                          <td><Link href={`/invoices/${encodeURIComponent(i.number)}`}>{i.number}</Link></td>
                          <td>{i.projects?.display_name ?? i.projects?.name ?? i.reference ?? ""}</td>
                          <td>{i.due ? fd(i.due) : ""}</td>
                          <td className="num">{d > 0 ? <span className={d > 60 ? "neg" : ""}>{d}</span> : <span className="muted">not yet</span>}</td>
                          <td className="num">{gbp(i.amount_due)}</td>
                          <td>{d > 0 ? <span className={`pill ${tone}`}>{label}</span> : null}</td>
                          <td className="muted" style={{ maxWidth: 260 }}>{to(i)}</td>
                        </tr>
                      );
                    })}</tbody>
                  </table>
                </details>
              </td>
              <td className="num"><b>{gbp(c.total)}</b></td>
              {c.bands.map(bar)}
              <td className="num">{c.oldest > 0 ? <span className={c.oldest > 60 ? "neg" : ""}>{c.oldest} days</span> : <span className="muted">–</span>}</td>
            </tr>
          ))}
          <tr><td><b>Total</b></td><td className="num"><b>{gbp(all)}</b></td>{bandTotals.map(bar)}<td /></tr>
        </tbody>
      </table></div>
    </section>
  );
}
