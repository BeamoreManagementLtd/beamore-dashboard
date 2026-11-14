import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, today } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Reports({ searchParams }: { searchParams: Promise<{ checker?: string }> }) {
  await requireProfile();
  const { checker } = await searchParams;
  const db = await createClient();
  let q = db.from("report_queue").select("*").order("due");
  if (checker) q = q.eq("checker", checker);
  const [{ data: rows }, { data: all }] = await Promise.all([q, db.from("report_queue").select("checker,due,scanned_at")]);
  const t = today();
  const a = all ?? [];
  const late = a.filter((r) => r.due && r.due < t).length;
  const count = (c: string) => a.filter((r) => r.checker === c).length;

  return (
    <>
      <div className="head">
        <div><h1>Reports waiting to check</h1><p>Word reports with no PDF yet, from the Reports Ready To Check sheet{a[0]?.scanned_at ? ` (scan ${fd(a[0].scanned_at)})` : ""}.</p></div>
      </div>
      <div className="tiles">
        <div className={`tile ${late ? "alert" : ""}`}><span className="label">Waiting</span><span className="big">{a.length}</span><span className="sub">{late} past due</span></div>
        <a className="tile" href="/reports?checker=Judy"><span className="label">Judy</span><span className="big">{count("Judy")}</span></a>
        <a className="tile" href="/reports?checker=Anel"><span className="label">Anel</span><span className="big">{count("Anel")}</span></a>
        <a className={`tile ${count("Unknown") ? "alert" : ""}`} href="/reports?checker=Unknown"><span className="label">No checker</span><span className="big">{count("Unknown")}</span></a>
      </div>
      <section className="panel">
        {checker && <p className="small">Showing {checker === "Unknown" ? "reports with no checker" : checker} · <a href="/reports">show all</a></p>}
        {!rows?.length ? <p className="empty">Nothing waiting. The sheet sync fills this list.</p> : (
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
    </>
  );
}
