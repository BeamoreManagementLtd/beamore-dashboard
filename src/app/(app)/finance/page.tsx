import { requireDirector } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fdt } from "@/lib/format";
import { syncNow } from "./actions";

export const dynamic = "force-dynamic";

export default async function Finance({ searchParams }: { searchParams: Promise<{ xero?: string; reason?: string }> }) {
  await requireDirector(); // page guard; the tables themselves are director-only in the database too
  const { xero, reason } = await searchParams;
  const db = await createClient();
  const [{ data: snaps }, { data: conn }, { data: runs }] = await Promise.all([
    db.from("finance_snapshots").select("*").order("taken_at", { ascending: false }).limit(12),
    db.rpc("xero_connection_status"),
    db.from("sync_runs").select("finished_at,ok,message").eq("source", "xero").order("started_at", { ascending: false }).limit(1),
  ]);
  const c = (conn as { tenant_name: string; connected_at: string }[] | null)?.[0];
  const last = runs?.[0];
  const latest = snaps?.find((s) => s.period === "latest");
  const month = snaps?.find((s) => /^\d{4}-\d{2}$/.test(s.period));
  const fytd = snaps?.find((s) => s.period.startsWith("FY"));
  const gp = (s?: { sales: number; subcontractors: number; cogs: number }) => (s ? (s.sales ?? 0) - (s.subcontractors ?? 0) - (s.cogs ?? 0) : null);
  const pct = (a: number | null, b?: number) => (a != null && b ? `${((a / b) * 100).toFixed(1)}%` : "—");

  return (
    <>
      <div className="head"><div><h1>Finance</h1><p>From Xero{latest ? ` · ${fdt(latest.taken_at)}` : ""}</p></div><span className="ronly">Director only</span></div>
      {xero === "connected" && <p className="callout info">Xero is connected and the first sync has run. It now updates every hour.</p>}
      {xero === "synced" && <p className="callout info">Synced with Xero just now.</p>}
      {xero === "error" && <p className="callout warn">Xero: {reason ?? "something went wrong"}</p>}
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <b>Xero</b>{" "}
            {c ? <span className="muted">connected to {c.tenant_name}. Updates every hour.</span> : <span className="muted">not connected yet.</span>}
            {last && (
              <span className="two">
                Last sync {fdt(last.finished_at)}: {last.ok ? last.message : <span className="neg">failed: {last.message}</span>}
              </span>
            )}
          </div>
          <div className="row">
            {c && <form action={syncNow}><button className="btn primary">Sync now</button></form>}
            <a className={`btn ${c ? "" : "primary"}`} href="/api/xero/connect">{c ? "Reconnect" : "Connect Xero"}</a>
          </div>
        </div>
      </section>
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
