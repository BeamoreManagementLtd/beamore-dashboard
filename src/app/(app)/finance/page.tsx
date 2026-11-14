import { requireDirector } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Finance() {
  await requireDirector(); // page guard; the tables themselves are director-only in the database too
  const db = await createClient();
  const { data: snaps } = await db.from("finance_snapshots").select("*").order("taken_at", { ascending: false }).limit(12);
  const latest = snaps?.find((s) => s.period === "latest");
  const month = snaps?.find((s) => /^\d{4}-\d{2}$/.test(s.period));
  const fytd = snaps?.find((s) => s.period.startsWith("FY"));
  const gp = (s?: { sales: number; subcontractors: number; cogs: number }) => (s ? (s.sales ?? 0) - (s.subcontractors ?? 0) - (s.cogs ?? 0) : null);
  const pct = (a: number | null, b?: number) => (a != null && b ? `${((a / b) * 100).toFixed(1)}%` : "—");

  return (
    <>
      <div className="head"><div><h1>Finance</h1><p>From Xero{latest ? ` · ${fd(latest.taken_at)}` : ""}</p></div><span className="ronly">Director only</span></div>
      {!snaps?.length ? <p className="callout info">No finance snapshot yet. It appears after the first Xero sync.</p> : (
        <>
          <div className="tiles">
            <div className="tile r"><span className="label">Cash at bank</span><span className="big">{gbp(latest?.cash)}</span></div>
            <div className="tile r"><span className="label">Owed to Beamore</span><span className="big">{gbp(latest?.receivables)}</span><span className="sub">{gbp(latest?.receivables_overdue)} overdue</span></div>
            <div className="tile r"><span className="label">Fees invoiced ({month?.period ?? "month"})</span><span className="big">{gbp(month?.sales)}</span></div>
            <div className="tile r"><span className="label">Gross profit ({month?.period ?? "month"})</span><span className="big">{gbp(gp(month))}</span><span className="sub">{pct(gp(month), month?.sales)}</span></div>
          </div>
          <section className="panel">
            <h2>Month and financial year to date</h2>
            <table>
              <thead><tr><th></th><th className="num">{month?.period ?? "Month"}</th><th className="num">FY to date</th></tr></thead>
              <tbody>
                <tr><td>Fees invoiced</td><td className="num">{gbp(month?.sales)}</td><td className="num">{gbp(fytd?.sales)}</td></tr>
                <tr><td>Clerk costs (subcontractors)</td><td className="num">{gbp(month?.subcontractors)}</td><td className="num">{gbp(fytd?.subcontractors)}</td></tr>
                <tr><td>Gross profit</td><td className="num">{gbp(gp(month))}</td><td className="num">{gbp(gp(fytd))}</td></tr>
                <tr><td>Margin</td><td className="num">{pct(gp(month), month?.sales)}</td><td className="num">{pct(gp(fytd), fytd?.sales)}</td></tr>
                <tr><td>Net profit</td><td className="num">{gbp(month?.net_profit)}</td><td className="num">{gbp(fytd?.net_profit)}</td></tr>
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}
