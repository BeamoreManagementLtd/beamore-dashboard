import { createClient } from "@/lib/supabase/server";
import { fdt } from "@/lib/format";

type Row = {
  id: string; file_name: string; status: string; score: number | null; created_at: string;
  fixes: { beamore?: { ok: boolean; why: string }; summary?: string } | null;
  clerks: { name: string } | null; projects: { name: string; display_name: string | null } | null;
};

/**
 * Clerks' own checks before uploading (Ronan, 18 Nov 2026), on the Reports page: any report that doesn't look like a
 * Beamore report is highlighted ("highlight to me if anyone tries to check a report that's not a Beamore report"),
 * and the last two weeks' checks are listed underneath. Directors only (the table is director-only in the database).
 */
export async function Prechecks() {
  const db = await createClient();
  const since = new Date(Date.now() - 14 * 864e5).toISOString();
  const { data } = await db.from("report_prechecks").select("id,file_name,status,score,created_at,fixes,clerks(name),projects(name,display_name)")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as unknown as Row[];
  if (!rows.length) return null;
  const odd = rows.filter((r) => r.fixes?.beamore && !r.fixes.beamore.ok);
  const job = (r: Row) => r.projects?.display_name ?? r.projects?.name ?? "";
  return (
    <>
      {!!odd.length && (
        <div className="callout bad">
          <b>Not a Beamore report?</b> {odd.length === 1 ? "A clerk has" : `${odd.length} times clerks have`} pre-checked a report that doesn&apos;t look like one of ours (it names neither Beamore nor the job they chose):
          <ul style={{ margin: "6px 0 0" }}>
            {odd.map((r) => (
              <li key={r.id}><b>{r.clerks?.name ?? "?"}</b>, {fdt(r.created_at)}: &ldquo;{r.file_name}&rdquo; (chose {job(r)}){r.fixes?.summary ? <span className="muted">. What it is: {r.fixes.summary.slice(0, 220)}</span> : null}</li>
            ))}
          </ul>
        </div>
      )}
      <details className="small" style={{ margin: "0 0 10px" }}>
        <summary style={{ cursor: "pointer" }}>Clerks&apos; pre-checks in the last two weeks ({rows.length}): reports they checked themselves before uploading</summary>
        <table className="small" style={{ marginTop: 6 }}>
          <thead><tr><th>When</th><th>Clerk</th><th>Job</th><th>File</th><th className="num">Score</th><th>Beamore report?</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td>{fdt(r.created_at)}</td>
              <td>{r.clerks?.name ?? ""}</td>
              <td>{job(r)}</td>
              <td>{r.file_name}</td>
              <td className="num">{r.status === "done" && r.score !== null ? Math.round(Number(r.score)) : r.status === "failed" ? "failed" : "…"}</td>
              <td>{r.fixes?.beamore ? (r.fixes.beamore.ok ? <span className="muted">Yes</span> : <span className="neg">{r.fixes.beamore.why}</span>) : ""}</td>
            </tr>
          ))}</tbody>
        </table>
      </details>
    </>
  );
}
