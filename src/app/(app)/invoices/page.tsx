import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd, today, daysBetween, CHASE_STATUS } from "@/lib/format";

export const dynamic = "force-dynamic";

type Row = {
  id: string; number: string; reference: string | null; due: string; amount_due: number;
  clients: { name: string } | null;
  chase_state: { status: string; next_action: string | null; next_action_due: string | null; owner_id: string | null } | null;
};

export default async function Invoices() {
  await requireProfile(); // both roles can see and update the chase queue
  const db = await createClient();
  const t = today();
  const { data } = await db
    .from("invoices")
    .select("id,number,reference,due,amount_due,clients(name),chase_state(status,next_action,next_action_due,owner_id)")
    .gt("amount_due", 0)
    .lt("due", t)
    .order("due");
  const rows = (data ?? []) as unknown as Row[];
  const total = rows.reduce((s, r) => s + Number(r.amount_due), 0);

  return (
    <>
      <div className="head">
        <div><h1>Overdue client invoices</h1><p>{rows.length} invoices · {gbp(total)} including VAT</p></div>
      </div>
      <section className="panel">
        {rows.length === 0 ? <p className="empty">No overdue invoices. The Xero sync fills this list.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Invoice</th><th>Client</th><th className="num">Outstanding</th><th className="num">Days overdue</th><th>Status</th><th>Next action</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const cs = Array.isArray(r.chase_state) ? r.chase_state[0] : r.chase_state;
                const [tone, label] = CHASE_STATUS[cs?.status ?? "new"];
                const d = daysBetween(r.due, t);
                return (
                  <tr key={r.id}>
                    <td className="mono"><Link href={`/invoices/${encodeURIComponent(r.number)}`}>{r.number}</Link></td>
                    <td><b>{r.clients?.name}</b><span className="two">{r.reference}</span></td>
                    <td className="num">{gbp(r.amount_due)}</td>
                    <td className={`num ${d > 60 ? "neg" : ""}`}><b>{d}</b><span className="two">due {fd(r.due)}</span></td>
                    <td><span className={`pill ${tone}`}>{label}</span></td>
                    <td>{cs?.next_action ?? <span className="muted">Not set</span>}<span className="two">{fd(cs?.next_action_due)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
