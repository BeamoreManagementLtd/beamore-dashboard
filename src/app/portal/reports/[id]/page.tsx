import Link from "next/link";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { fmtDate } from "@/lib/portal/data";
import { AiNote } from "../feedback";
import { OFFICE_ONLY as OFFICE } from "@/lib/reports/clerk-view";

export const dynamic = "force-dynamic";

type Part = { label: string; of: number; got: number; note?: string; improve?: string };
type Fixes = {
  spelling?: { find: string; replace: string }[]; shrunk?: number; rotated?: number; stretched?: number; enlarged?: number; uniform?: number;
  renamed?: string | null; score_parts?: Part[];
};
const n1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** One report's AI feedback for its clerk: what was fixed, what the check noticed, how each part scored. */
export default async function ReportFeedback({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requirePortalUser();
  if (!me.clerk) notFound();
  const db = createServiceClient();
  const { data: r } = await db.from("reports").select("id,clerk_id,file_name,renamed_from,visit_date,uploaded_at,status,pdf_file_id,issues,clerk_points,fixes,score,projects(name,display_name)")
    .eq("id", id).not("checked_at", "is", null).maybeSingle();
  if (!r || r.clerk_id !== me.clerk.id) notFound();
  const f = (r.fixes ?? {}) as Fixes;
  const p = r.projects as unknown as { name?: string; display_name?: string } | null;
  const issues = ((r.issues ?? []) as { severity: string; text: string }[]).filter((i) => !OFFICE.test(i.text));
  const points = ((r.clerk_points ?? []) as string[]).filter((t) => !OFFICE.test(t));
  const fixed = [
    f.spelling?.length ? `${f.spelling.length} spelling or typing slip${f.spelling.length === 1 ? "" : "s"} corrected` : "",
    f.uniform ? `${f.uniform} photo${f.uniform === 1 ? "" : "s"} set to the same size as the others` : "",
    f.stretched ? `${f.stretched} stretched photo${f.stretched === 1 ? "" : "s"} put back to the right shape` : "",
    f.enlarged ? `${f.enlarged} small photo${f.enlarged === 1 ? "" : "s"} made bigger` : "",
    f.shrunk ? `${f.shrunk} photo${f.shrunk === 1 ? "" : "s"} made smaller in file size` : "",
    f.rotated ? `${f.rotated} photo${f.rotated === 1 ? "" : "s"} turned the right way up` : "",
    f.renamed ? `File name changed to match the others in the folder: ${f.renamed.replace(/\.docx?$/i, "")}` : "",
  ].filter(Boolean);
  const parts = (f.score_parts ?? []).filter((x) => x.of > 0);

  return (
    <>
      <section className="card">
        <p className="small"><Link href="/portal/reports">← Your reports</Link></p>
        <h1 style={{ marginBottom: 2 }}>{p?.display_name ?? p?.name ?? "Report"}</h1>
        <p className="muted" style={{ marginTop: 0 }}>{r.file_name} · {r.visit_date ? `visit ${fmtDate(r.visit_date)}` : `uploaded ${fmtDate(r.uploaded_at)}`}
          {r.pdf_file_id && (r.status === "sent" || r.status === "done") ? <> · <a href={`https://drive.google.com/file/d/${r.pdf_file_id}/view`} target="_blank" rel="noreferrer">the version that was sent</a></> : null}</p>
        <AiNote />
      </section>

      <section className="card">
        <h2>What was fixed for you</h2>
        {fixed.length ? <ul>{fixed.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="muted">Nothing needed fixing.</p>}
        {!!f.spelling?.length && (
          <details><summary className="small">See the spelling corrections</summary>
            <ul className="small">{f.spelling.slice(0, 40).map((s, k) => <li key={k}>&ldquo;{s.find}&rdquo; → &ldquo;{s.replace}&rdquo;</li>)}</ul>
          </details>
        )}
      </section>

      <section className="card">
        <h2>Suggestions</h2>
        {points.length ? <ul>{points.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="muted">No suggestions this time.</p>}
        {!!issues.length && (
          <details><summary className="small">Everything the check noticed ({issues.length})</summary>
            <ul className="small">{issues.map((i, k) => <li key={k}>{i.text}</li>)}</ul>
          </details>
        )}
      </section>

      {!!parts.length && (
        <section className="card">
          <h2>Score: {r.score !== null && r.score !== undefined ? `${Math.round(Number(r.score))} out of 100` : "not scored"}</h2>
          <p className="small muted" style={{ marginTop: 0 }}>How each part of the report did:</p>
          <table className="ptable">
            <thead><tr><th>Part</th><th style={{ textAlign: "right" }}>Mark</th><th>What it means</th></tr></thead>
            <tbody>{parts.map((x) => (
              <tr key={x.label}>
                <td>{x.label}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{n1(x.got)} of {x.of}</td>
                <td className="small">{x.note}{x.improve ? <><br /><span className="muted">{x.improve}</span></> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </>
  );
}
