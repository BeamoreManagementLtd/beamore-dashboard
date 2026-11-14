import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, fdt, today } from "@/lib/format";
import { refreshReports } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Turn = { month: string; clerk: string; reports: number; avg_days: number; over_two_days: number; review_required: number };

export default async function Reports({ searchParams }: { searchParams: Promise<{ checker?: string; month?: string; refreshed?: string; error?: string }> }) {
  await requireProfile();
  const { checker, month, refreshed, error } = await searchParams;
  const db = await createClient();
  const t = today();
  const thisMonth = `${t.slice(0, 7)}-01`;
  const m = /^\d{4}-\d{2}$/.test(month ?? "") ? `${month}-01` : thisMonth;
  let q = db.from("report_queue").select("*").order("due");
  if (checker) q = q.eq("checker", checker);
  const [{ data: rows }, { data: all }, { data: turn }, { data: lastRun }] = await Promise.all([
    q,
    db.from("report_queue").select("checker,due,scanned_at"),
    db.from("report_turnaround").select("*").gte("month", new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 6, 1)).toISOString().slice(0, 10)),
    db.from("sync_runs").select("finished_at,ok,message").eq("source", "reports").neq("message", "Report files unchanged since last read").order("started_at", { ascending: false }).limit(1),
  ]);
  const a = all ?? [];
  const late = a.filter((r) => r.due && r.due < t).length;
  const checkers = [...new Set(a.map((r) => r.checker ?? "Unknown"))].filter((c) => c !== "Unknown").sort();
  const count = (c: string) => a.filter((r) => r.checker === c).length;

  const tr = (turn ?? []) as Turn[];
  const months = [...new Set(tr.map((x) => x.month))].sort().reverse();
  const cur = tr.filter((x) => x.month === m).sort((x, y) => y.avg_days - x.avg_days);
  const sum = (k: keyof Turn) => cur.reduce((s, x) => s + Number(x[k]), 0);
  const teamAvg = cur.length ? cur.reduce((s, x) => s + x.avg_days * x.reports, 0) / Math.max(sum("reports"), 1) : null;
  const label = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <div className="head">
        <div><h1>Reports</h1><p>Waiting to check (Word reports with no PDF yet), and how quickly clerks send reports in.</p></div>
        <form action={refreshReports}><button className="btn">Refresh now</button></form>
      </div>
      {error && <p className="callout bad">{error}</p>}
      {refreshed && <p className="callout info">Reports read from Drive just now.</p>}
      {lastRun?.[0] && <p className="small muted">Last read {fdt(lastRun[0].finished_at)}: {lastRun[0].ok ? lastRun[0].message : <span className="neg">failed: {lastRun[0].message}</span>}. Checked every 30 minutes.</p>}

      <h2>Waiting to check</h2>
      <div className="tiles">
        <a className={`tile ${late ? "alert" : ""}`} href="/reports"><span className="label">Waiting</span><span className="big">{a.length}</span><span className="sub">{late} past due</span></a>
        {checkers.map((c) => (
          <a key={c} className="tile" href={`/reports?checker=${encodeURIComponent(c)}`}><span className="label">{c}</span><span className="big">{count(c)}</span>
            <span className="sub">{a.filter((r) => r.checker === c && r.due && r.due < t).length} past due</span></a>
        ))}
        <a className={`tile ${count("Unknown") ? "alert" : ""}`} href="/reports?checker=Unknown"><span className="label">No checker</span><span className="big">{count("Unknown")}</span></a>
      </div>
      <section className="panel">
        {checker && <p className="small">Showing {checker === "Unknown" ? "reports with no checker" : checker} · <a href="/reports">show all</a></p>}
        {!rows?.length ? <p className="empty">Nothing waiting.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Project</th><th>Report</th><th>Report date</th><th>Due</th><th>Checker</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.project_name}</b><span className="two">{r.folder}</span></td>
                  <td className="small">{r.report_name}</td>
                  <td>{fd(r.report_date)}</td>
                  <td className={r.due && r.due < t ? "neg" : ""}>{fd(r.due)}</td>
                  <td>{r.checker === "Unknown" ? <span className="pill bad">None</span> : r.checker}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>

      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <h2>Turnaround: {label(m)}</h2>
        <nav className="row">
          {months.map((x) => <a key={x} className={`btn ${x === m ? "primary" : ""}`} href={`/reports?month=${x.slice(0, 7)}`}>{label(x).split(" ")[0]}</a>)}
        </nav>
      </div>
      <div className="tiles">
        <div className="tile"><span className="label">Reports completed</span><span className="big">{sum("reports")}</span></div>
        <div className="tile"><span className="label">Team average</span><span className="big">{teamAvg == null ? "—" : `${teamAvg.toFixed(1)} days`}</span><span className="sub">working days, visit to report</span></div>
        <div className={`tile ${sum("over_two_days") ? "alert" : ""}`}><span className="label">Over 2 days</span><span className="big">{sum("over_two_days")}</span></div>
        <div className="tile"><span className="label">Review required</span><span className="big">{sum("review_required")}</span></div>
      </div>
      <section className="panel">
        {!cur.length ? <p className="empty">No reports logged for this month.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Clerk</th><th className="num">Reports</th><th className="num">Average days</th><th className="num">Over 2 days</th><th className="num">Review required</th></tr></thead>
            <tbody>
              {cur.map((x) => (
                <tr key={x.clerk}>
                  <td><b>{x.clerk}</b></td>
                  <td className="num">{x.reports}</td>
                  <td className={`num ${x.avg_days > 2 ? "neg" : ""}`}>{x.avg_days}</td>
                  <td className={`num ${x.over_two_days ? "neg" : ""}`}>{x.over_two_days}</td>
                  <td className="num">{x.review_required}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
