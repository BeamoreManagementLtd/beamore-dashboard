import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { fd, fdt } from "@/lib/format";
import { draftFor } from "@/lib/reports/pipeline";
import { userConnection } from "@/lib/google-user";
import { assignChecker, sendReport, markDone, ignoreReport, checkAgain } from "../actions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Issue = { severity: "high" | "medium" | "low"; kind: string; text: string };
const SEV: Record<string, [string, string]> = { high: ["Must check", "bad"], medium: ["Should fix", "warn"], low: ["Minor", "muted"] };

/** One report: what the AI found, then approve and send it from your own email with the standard email. */
export default async function ReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const me = await requireProfile();
  const { id } = await params;
  const { error } = await searchParams;
  const db = await createClient();
  const { data: r } = await db.from("reports").select("*,projects(id,name),clerks(name)").eq("id", id).maybeSingle();
  if (!r) notFound();
  const admin = createServiceClient();
  const [{ data: staff }, conn, draft] = await Promise.all([
    db.from("profiles").select("id,full_name,email").order("full_name"),
    userConnection(admin, me.id),
    draftFor(admin, id, { full_name: me.full_name, email: me.email }),
  ]);
  const p = r.projects as unknown as { id: string; name: string } | null;
  const issues = (r.issues ?? []) as Issue[];
  const photos = (r.photos ?? {}) as { count?: number; blurry?: number; smallOnPage?: number; stretched?: number; shrunk?: number };
  const mb = (n: number | null) => (n ? `${(n / 1e6).toFixed(1)} MB` : "—");
  const open = ["new", "checking", "ready", "failed", "approved"].includes(r.status);
  const nameOf = (pid: string | null) => (staff ?? []).find((s) => s.id === pid)?.full_name ?? null;

  return (
    <>
      <p className="small"><Link href="/reports">Reports</Link>{p && <> · <Link href={`/projects/${p.id}`}>{p.name}</Link></>}</p>
      <div className="head"><div><h1 style={{ wordBreak: "break-word" }}>{r.file_name}</h1>
        <p>{p?.name ?? r.project_folder_name} · {r.folder_name} · {(r.clerks as unknown as { name?: string } | null)?.name ?? r.clerk_name ?? "clerk not known"}{r.report_number ? ` · No. ${r.report_number}` : ""}</p></div></div>
      {error && <p className="callout bad">{error}</p>}
      {r.error && r.status !== "failed" && <p className="callout bad">{r.error}</p>}

      <div className="grid2">
        <section className="panel">
          <h2>What the check found</h2>
          {r.status === "new" && <p className="muted">Waiting for the clerk to finish with it (30 minutes untouched), then it&apos;s checked automatically.</p>}
          {r.status === "checking" && <p className="muted">Being checked now…</p>}
          {r.status === "failed" && <><p className="callout bad">The check failed: {r.error}</p><form action={checkAgain.bind(null, id)}><button className="btn">Try the check again</button></form></>}
          {r.ai_summary && <p>{r.ai_summary}</p>}
          {!!issues.length && <ul className="plain">{issues.map((i, k) => <li key={k} style={{ marginBottom: 6 }}><span className={`pill ${SEV[i.severity]?.[1] ?? "muted"}`}>{SEV[i.severity]?.[0] ?? i.severity}</span> {i.text}</li>)}</ul>}
          {r.checked_at && <p className="small muted">
            {r.spelling_fixed} spelling fix{r.spelling_fixed === 1 ? "" : "es"} put in as tracked changes; issues added as comments in the Word file.
            {" "}Photos: {photos.count ?? 0}{photos.blurry ? `, ${photos.blurry} low detail` : ""}{photos.smallOnPage ? `, ${photos.smallOnPage} shown small` : ""}{photos.stretched ? `, ${photos.stretched} stretched` : ""}{photos.shrunk ? `; ${photos.shrunk} made smaller` : ""}.
            {" "}File {mb(r.size_before)} → {mb(r.size_after)}. Checked {fdt(r.checked_at)}.</p>}
          <p className="row" style={{ gap: 8 }}>
            <a className="btn primary" href={`https://docs.google.com/document/d/${r.drive_file_id}/edit?rtpof=true`} target="_blank" rel="noreferrer">Open the report</a>
            {r.folder_id && <a className="btn" href={`https://drive.google.com/drive/folders/${r.folder_id}`} target="_blank" rel="noreferrer">Open its folder</a>}
          </p>
          <p className="small muted">Accept or reject the tracked changes and deal with the comments in the report, then approve and send. Anything left will be accepted and the comments left out of the PDF.</p>
        </section>

        <section className="panel">
          <h2>Details</h2>
          <table><tbody>
            <tr><td className="muted small">Visit date</td><td>{fd(r.visit_date)}</td></tr>
            <tr><td className="muted small">Uploaded</td><td>{fdt(r.uploaded_at)}</td></tr>
            <tr><td className="muted small">Status</td><td>{r.status}{r.sent_at ? ` · sent ${fdt(r.sent_at)} by ${nameOf(r.sent_by) ?? ""}` : r.done_at ? ` · done ${fdt(r.done_at)}` : ""}</td></tr>
            {r.sent_to && <tr><td className="muted small">Sent to</td><td className="small">{r.sent_to.join(", ")}{r.sent_cc?.length ? ` · cc ${r.sent_cc.join(", ")}` : ""}</td></tr>}
          </tbody></table>
          <form action={assignChecker.bind(null, id)} className="row" style={{ gap: 6, marginTop: 8, alignItems: "center" }}>
            <label className="small muted" htmlFor="ck">Checker</label>
            <select id="ck" name="checker" defaultValue={r.checker_id ?? ""}><option value="">Nobody</option>{(staff ?? []).map((s) => <option key={s.id} value={s.id}>{s.full_name ?? s.email}</option>)}</select>
            <label className="small"><input type="checkbox" name="for_project" defaultChecked /> and this project&apos;s future reports</label>
            <button className="btn small">Save</button>
          </form>
        </section>
      </div>

      {open && (
        <section className="panel">
          <h2>Approve and send</h2>
          {!conn ? (
            <p className="callout warn">To send reports from your own email, connect it once: <Link className="btn small" href="/api/google/connect?for=me">Connect my email</Link></p>
          ) : (
            <form action={sendReport.bind(null, id)} className="form">
              <p className="small muted">Sends from {conn.email}. The PDF is made from the report as it is now, saved next to the Word file, and attached. To change who it goes to for every report, use the project&apos;s Email lists{p && <> (<Link href={`/projects/${p.id}`}>open the project</Link>)</>}.</p>
              <div className="field"><label htmlFor="to">To</label><input id="to" name="to" defaultValue={draft.to.join("; ")} required /></div>
              <div className="field"><label htmlFor="cc">CC</label><input id="cc" name="cc" defaultValue={draft.cc.join("; ")} /></div>
              <div className="field"><label htmlFor="su">Subject</label><input id="su" name="subject" defaultValue={draft.subject} required /></div>
              <div className="field"><label htmlFor="bo">Email</label><textarea id="bo" name="body" rows={9} defaultValue={draft.body} /></div>
              <button className="btn primary" disabled={r.status === "checking" || r.status === "approved"}>Approve and send</button>
            </form>
          )}
          <div className="row" style={{ gap: 8, marginTop: 10 }}>
            <form action={markDone.bind(null, id)}><button className="btn small">Already sent another way</button></form>
            <form action={ignoreReport.bind(null, id)}><button className="btn small">Not a report: skip it</button></form>
          </div>
        </section>
      )}
    </>
  );
}
