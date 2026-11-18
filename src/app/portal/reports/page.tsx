import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { fmtDate } from "@/lib/portal/data";
import { AiNote, AiSwitch } from "./feedback";
import { ScoreGraph } from "./score-graph";
import { PrecheckBox } from "./precheck-box";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // the check before uploading runs straight after the upload (about two minutes)

/**
 * Your reports (Ronan, 17 Nov 2026): a clerk who has switched it on can see the AI feedback on each of their reports:
 * what was fixed, what the check noticed and how each part scored. Their own reports only.
 */
export default async function YourReports() {
  const me = await requirePortalUser();
  if (!me.clerk) return <section className="card"><h1>Your reports</h1><p className="muted">Clerks see their reports here.</p></section>;
  const db = createServiceClient();
  const { data: c } = await db.from("clerks").select("ai_feedback,ai_feedback_email").eq("id", me.clerk.id).single();
  const on = !!c?.ai_feedback;
  const { data: reps } = on
    ? await db.from("reports").select("id,file_name,visit_date,uploaded_at,status,report_number,score,projects(name,display_name)")
      .eq("clerk_id", me.clerk.id).not("checked_at", "is", null).gte("uploaded_at", new Date(Date.now() - 183 * 864e5).toISOString()).order("uploaded_at", { ascending: false }).limit(80)
    : { data: [] };
  // checking a report before it goes in Google Drive (Ronan, 18 Nov 2026): open to every clerk, on their current jobs
  const [{ data: jobs }, { data: checks }] = await Promise.all([
    db.from("projects").select("id,name,display_name").or(`clerk_id.eq.${me.clerk.id},clerk_me_id.eq.${me.clerk.id}`).in("stage", ["won_arranging", "won_preparing", "live", "on_hold"]).order("name"),
    db.from("report_prechecks").select("id,file_name,status,score,created_at,projects(name,display_name)").eq("clerk_id", me.clerk.id).order("created_at", { ascending: false }).limit(10),
  ]);
  return (
    <>
      <section className="card">
        <h1>Your reports</h1>
        <AiNote />
        <AiSwitch on={on} email={!!c?.ai_feedback_email} viewingAs={me.viewingAs} />
      </section>
      <section className="card">
        <h2>Check before you upload</h2>
        <PrecheckBox jobs={(jobs ?? []).map((j) => ({ id: j.id, name: j.display_name ?? j.name }))} disabled={me.viewingAs ? "Only the clerk can check reports here." : undefined} />
        {!!checks?.length && (
          <table className="ptable" style={{ marginTop: 12 }}>
            <thead><tr><th>Checked</th><th>Job</th><th>Report</th><th style={{ textAlign: "right" }}>Score</th><th /></tr></thead>
            <tbody>{checks.map((k) => {
              const p = k.projects as unknown as { name?: string; display_name?: string } | null;
              return (
                <tr key={k.id}>
                  <td>{fmtDate(k.created_at)}</td>
                  <td>{p?.display_name ?? p?.name ?? ""}</td>
                  <td className="clip">{k.file_name}</td>
                  <td style={{ textAlign: "right" }}>{k.status === "done" && k.score !== null ? `${Math.round(Number(k.score))}/100` : k.status === "failed" ? "Didn't work" : "Checking…"}</td>
                  <td><Link href={`/portal/reports/check/${k.id}`}>See feedback →</Link></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </section>
      {on && (
        <ScoreGraph rows={(reps ?? []).filter((r) => r.score !== null && r.score !== undefined)
          .map((r) => ({ id: r.id, when: (r.visit_date ?? r.uploaded_at.slice(0, 10)) as string, score: Number(r.score), name: r.file_name as string }))
          .sort((a, b) => a.when.localeCompare(b.when))} />
      )}
      {on && (
        <section className="card">
          <h2>Last six months</h2>
          {!reps?.length ? <p className="muted">No checked reports yet. They appear here once the office has run them through the check.</p> : (
            <table className="ptable">
              <thead><tr><th>Visit</th><th>Job</th><th>Report</th><th style={{ textAlign: "right" }}>Score</th><th>Status</th><th /></tr></thead>
              <tbody>{reps.map((r) => {
                const p = r.projects as unknown as { name?: string; display_name?: string } | null;
                return (
                  <tr key={r.id}>
                    <td>{r.visit_date ? fmtDate(r.visit_date) : fmtDate(r.uploaded_at)}</td>
                    <td>{p?.display_name ?? p?.name ?? ""}</td>
                    <td className="clip">{r.file_name}</td>
                    <td style={{ textAlign: "right" }}>{r.score !== null && r.score !== undefined ? `${Math.round(Number(r.score))}/100` : ""}</td>
                    <td className="small">{r.status === "sent" || r.status === "done" ? "Sent" : "With the office"}</td>
                    <td><Link href={`/portal/reports/${r.id}`}>See feedback →</Link></td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </section>
      )}
    </>
  );
}
