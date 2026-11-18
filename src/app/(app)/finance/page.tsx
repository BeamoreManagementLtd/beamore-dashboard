import { requireDirector } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fdt } from "@/lib/format";
import { syncNow, syncDiaryNow, syncGmailNow, setupTracking } from "./actions";
import { OwedBreakdown } from "./owed";
import { estimateMonth, monthsToEstimate } from "@/lib/finance-estimate";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // "Read diary now" / "Read Gmail now" can take a minute or two

export default async function Finance({ searchParams }: { searchParams: Promise<{ xero?: string; diary?: string; reason?: string }> }) {
  await requireDirector(); // page guard; the tables themselves are director-only in the database too
  const { xero, diary, reason } = await searchParams;
  const db = await createClient();
  const [{ data: snaps }, { data: conn }, { data: runs }, { data: gconn }, { data: druns }, { data: gmruns }, { data: truns }] = await Promise.all([
    db.from("finance_snapshots").select("*").order("taken_at", { ascending: false }).limit(12),
    db.rpc("xero_connection_status"),
    db.from("sync_runs").select("finished_at,ok,message").eq("source", "xero").order("started_at", { ascending: false }).limit(1),
    db.rpc("google_connection_status"),
    // the last diary read that did something (hourly checks that find no change are skipped here)
    db.from("sync_runs").select("finished_at,ok,message").eq("source", "diary").neq("message", "Diary unchanged since last read").order("started_at", { ascending: false }).limit(1),
    db.from("sync_runs").select("finished_at,ok,message").eq("source", "gmail").order("started_at", { ascending: false }).limit(1),
    db.from("sync_runs").select("finished_at,ok,message").eq("source", "xero-tracking").order("started_at", { ascending: false }).limit(1),
  ]);
  const glast = gmruns?.[0];
  const tlast = truns?.[0];
  const c = (conn as { tenant_name: string; connected_at: string }[] | null)?.[0];
  const last = runs?.[0];
  const g = (gconn as { email: string; connected_at: string; diary_modified_time: string | null }[] | null)?.[0];
  const dlast = druns?.[0];
  const latest = snaps?.find((s) => s.period === "latest");
  const month = snaps?.find((s) => /^\d{4}-\d{2}$/.test(s.period));
  const fytd = snaps?.find((s) => s.period.startsWith("FY"));
  const gp = (s?: { sales: number; subcontractors: number; cogs: number }) => (s ? (s.sales ?? 0) - (s.subcontractors ?? 0) - (s.cogs ?? 0) : null);
  const pct = (a: number | null, b?: number) => (a != null && b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  // next month from the diary's grey side, with overheads as in Xero's last month (Ronan, 18 Nov 2026)
  const overheads = month ? (gp(month) ?? 0) - Number(month.net_profit ?? 0) : 0;
  const estimates = await Promise.all((await monthsToEstimate(db, month?.period)).map((m) => estimateMonth(db, m)));
  const monthName = (m: string) => new Date(m + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  // drafts waiting in Xero (Ronan, 18 Nov 2026: "how many invoices are still in draft")
  const [{ data: drafts }, { data: held }] = await Promise.all([
    db.from("xero_draft_invoices").select("xero_invoice_id,number,contact,reference,issued,subtotal,projects(display_name)").order("issued"),
    db.from("held_draft_contacts").select("contact"),
  ]);
  const heldSet = new Set((held ?? []).map((h) => h.contact));
  const draftTotal = (drafts ?? []).reduce((n, d) => n + Number(d.subtotal ?? 0), 0);

  return (
    <>
      <div className="head"><div><h1>Finance</h1><p>From Xero{latest ? ` · ${fdt(latest.taken_at)}` : ""} · <a href="/finance/fees">Fees by project →</a></p></div><span className="ronly">Director only</span></div>
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
      {xero === "tracking" && <p className="callout info">Project tracking updated in Xero.</p>}
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <b>Project tracking in Xero</b>{" "}
            <span className="muted">two tracking categories, “Education projects” and “Other projects”, each with one option per current job (“St Aidans 1073”), so draft invoices are tagged and Xero reports can be run by project. Up to 100 jobs in each; quiet jobs are archived and come back when invoiced again. Updated every morning; clients never see tracking.</span>
            {tlast && (
              <span className="two">
                Last run {fdt(tlast.finished_at)}: {tlast.ok ? tlast.message : <span className="neg">failed: {tlast.message}</span>}
              </span>
            )}
          </div>
          {c && <form action={setupTracking}><button className="btn">{tlast?.ok ? "Update project tracking now" : "Set up project tracking in Xero"}</button></form>}
        </div>
      </section>
      {diary === "connected" && <p className="callout info">Google Drive is connected and the diary has been read. It’s checked for changes every hour.</p>}
      {diary === "synced" && <p className="callout info">Diary read just now.</p>}
      {diary === "error" && <p className="callout warn">Diary: {reason ?? "something went wrong"}</p>}
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <b>Diary</b>{" "}
            {g ? <span className="muted">read from Google Drive ({g.email}). Checked hourly{g.diary_modified_time ? `; last saved ${g.diary_modified_time.split("|").map((x) => { const [y, ...t] = x.split(":"); return `Diary ${y} ${fdt(t.join(":"))}`; }).join(", ")}` : ""}.</span> : <span className="muted">Google Drive not connected yet.</span>}
            {dlast && (
              <span className="two">
                Last read {fdt(dlast.finished_at)}: {dlast.ok ? dlast.message : <span className="neg">failed: {dlast.message}</span>}
              </span>
            )}
          </div>
          <div className="row">
            {g && <form action={syncDiaryNow}><button className="btn primary">Read diary now</button></form>}
            <a className={`btn ${g ? "" : "primary"}`} href="/api/google/connect">{g ? "Reconnect" : "Connect Google Drive"}</a>
          </div>
        </div>
      </section>
      {diary === "gmail" && <p className="callout info">Gmail read just now.</p>}
      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <b>Gmail</b>{" "}
            <span className="muted">chase emails that mention an outstanding invoice number are added to that invoice’s timeline every hour (read only).</span>
            {glast && (
              <span className="two">
                Last read {fdt(glast.finished_at)}: {glast.ok ? glast.message : <span className="neg">failed: {glast.message}</span>}
              </span>
            )}
          </div>
          <div className="row">
            {g && <form action={syncGmailNow}><button className="btn primary">Read Gmail now</button></form>}
            <a className="btn" href="/api/google/connect">{glast && !glast.ok ? "Reconnect Google to allow Gmail" : "Reconnect"}</a>
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
            {estimates[0] && (() => {
              const e = estimates[0], egp = e.fees - e.clerks, enp = egp - overheads, short = monthName(e.month).split(" ")[0];
              return (
                <>
                  <div className="tile r"><span className="label">Estimated gross profit ({short})</span><span className="big">{gbp(egp)}</span><span className="sub">{pct(egp, e.fees)} of {gbp(e.fees)} fees, from the diary</span></div>
                  <div className="tile r"><span className="label">Estimated net profit ({short})</span><span className={`big${enp < 0 ? " neg" : ""}`}>{gbp(enp)}</span><span className="sub">after {gbp(overheads)} overheads</span></div>
                </>
              );
            })()}
          </div>
          <OwedBreakdown />
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
          {estimates.map((e) => {
            const net = e.fees - e.clerks - overheads;
            return (
              <section className="panel" key={e.month}>
                <h2>Estimated net profit, {monthName(e.month)}</h2>
                <p className="small muted">From the grey (planned) side of the diary: {e.days} days at each job&apos;s day rate (the rate kept for the job, else its last invoice less VAT), less what each planned day costs in clerks, less overheads as in Xero for {month?.period}. An estimate: the real figure follows what&apos;s charged on the salmon side and invoiced.</p>
                <table>
                  <tbody>
                    <tr><td>Fees ({e.days - e.unpricedDays} planned days priced)</td><td className="num">{gbp(e.fees)}</td></tr>
                    <tr><td>Clerk costs</td><td className="num">−{gbp(e.clerks)}</td></tr>
                    <tr><td>Gross profit</td><td className="num">{gbp(e.fees - e.clerks)} <span className="muted small">{pct(e.fees - e.clerks, e.fees)}</span></td></tr>
                    <tr><td>Overheads (as {month?.period})</td><td className="num">−{gbp(overheads)}</td></tr>
                    <tr><td><b>Estimated net profit</b></td><td className="num"><b className={net < 0 ? "neg" : ""}>{gbp(net)}</b></td></tr>
                  </tbody>
                </table>
                {!!e.unpricedDays && (
                  <p className="small muted">Not priced: {e.unpricedDays} planned days on jobs with no day rate or invoice yet ({e.unpriced.map((u) => `${u.name} ${u.days}`).join(", ")}). Their clerk costs are included, so the profit is understated by their fees; add a day rate on the job to include them.</p>
                )}
              </section>
            );
          })}
          <section className="panel">
            <h2>Invoices still in draft in Xero</h2>
            {!drafts?.length ? <p className="muted small">No draft invoices.</p> : (
              <>
                <p className="small muted">{drafts.length} draft invoice{drafts.length === 1 ? "" : "s"} worth {gbp(draftTotal)} before VAT, not yet approved or sent{heldSet.size ? `; those marked held are kept back on purpose` : ""}.</p>
                <div className="tbl-wrap"><table className="small">
                  <thead><tr><th>Dated</th><th>Invoice</th><th>Contact</th><th>Job</th><th>Reference</th><th className="num">Before VAT</th></tr></thead>
                  <tbody>{drafts.map((d) => (
                    <tr key={d.xero_invoice_id}>
                      <td>{d.issued ? new Date(d.issued + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : ""}</td>
                      <td>{d.number ?? <span className="muted">no number</span>}</td>
                      <td>{d.contact}{heldSet.has(d.contact ?? "") ? <span className="pill small"> held</span> : null}</td>
                      <td>{(d.projects as unknown as { display_name: string } | null)?.display_name ?? ""}</td>
                      <td className="muted">{d.reference}</td>
                      <td className="num">{gbp(d.subtotal)}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
