import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { fd, fdt } from "@/lib/format";
import { draftFor } from "@/lib/reports/pipeline";
import { userConnection } from "@/lib/google-user";
import { assignChecker, sendReport, markDone, ignoreReport, checkAgain, sendClerkEmail } from "../actions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Issue = { severity: "high" | "medium" | "low"; kind: string; text: string };

/** A friendly note to the clerk: what had to be fixed in this report and what to do next time. */
function clerkNote(r: Record<string, unknown>, sender: string) {
  const clerk = ((r.clerks as { name?: string } | null)?.name ?? (r.clerk_name as string | null) ?? "").split(" ")[0];
  const f = (r.fixes ?? {}) as { spelling?: { find: string; replace: string }[]; rotated?: number; shrunk?: number; stretched?: number; enlarged?: number; uniform?: number; mixed?: boolean; side_cm?: number | null; renamed?: string | null };
  const issues = ((r.issues ?? []) as Issue[]).filter((i) => i.severity !== "low" && i.kind !== "safety");
  // everything that had to be put right goes back to the clerk (Ronan, 15 Nov 2026)
  const fixed = [
    f.spelling?.length ? `${f.spelling.length} spelling/grammar correction${f.spelling.length === 1 ? "" : "s"} (e.g. ${f.spelling.slice(0, 3).map((s) => `"${s.find}" → "${s.replace}"`).join(", ")})` : null,
    f.renamed ? `the file name, to match your other reports in the folder (now "${f.renamed}")` : null,
    f.mixed ? `photos of different sizes, now all the same size (about ${f.side_cm ?? 6} cm wide, like Christian Tate's reports)` : null,
    f.stretched ? `${f.stretched} photo${f.stretched === 1 ? "" : "s"} stretched out of shape (please keep the shift key down when resizing)` : null,
    f.enlarged ? `${f.enlarged} photo${f.enlarged === 1 ? "" : "s"} too small to see on the page` : null,
    f.rotated ? `${f.rotated} photo${f.rotated === 1 ? "" : "s"} on their side` : null,
    f.shrunk ? `photos larger than needed (the file was ${(Number(r.size_before) / 1e6).toFixed(0)} MB; please resize before inserting)` : null,
    ...issues.map((i) => i.text),
  ].filter(Boolean) as string[];
  const tips = ((r.clerk_points ?? []) as string[]).filter(Boolean);
  if (!fixed.length && !tips.length) return `Hi ${clerk},\n\nThanks for your report (${r.file_name}). It needed no changes before it went out. Great work.\n\nKind regards,\n${sender}`;
  return [
    `Hi ${clerk},`, "",
    `Thanks for your report (${r.file_name}). A few things needed fixing before it went to the client:`,
    ...fixed.map((x) => `- ${x}`),
    ...(tips.length ? ["", "For your next reports, it would help if you could:", ...tips.map((x) => `- ${x}`)] : []),
    "", "Any questions, just give me a shout.", "", "Kind regards,", sender,
  ].join("\n");
}
const SEV: Record<string, [string, string]> = { high: ["Must check", "bad"], medium: ["Should fix", "warn"], low: ["Minor", "muted"] };

/** One report: what the AI found, then approve and send it from your own email with the standard email. */
export default async function ReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; clerk?: string }> }) {
  const me = await requireProfile();
  const { id } = await params;
  const { error, clerk } = await searchParams;
  const db = await createClient();
  const { data: r } = await db.from("reports").select("*,projects(id,name),clerks(name,email)").eq("id", id).maybeSingle();
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
  const open = ["new", "checking", "ready", "failed"].includes(r.status);
  const nameOf = (pid: string | null) => (staff ?? []).find((s) => s.id === pid)?.full_name ?? null;

  return (
    <>
      <p className="small"><Link href="/reports">Reports</Link>{p && <> · <Link href={`/projects/${p.id}`}>{p.name}</Link></>}</p>
      <div className="head"><div><h1 style={{ wordBreak: "break-word" }}>{r.file_name}</h1>
        <p>{p?.name ?? r.project_folder_name} · {r.folder_name} · {(r.clerks as unknown as { name?: string } | null)?.name ?? r.clerk_name ?? "clerk not known"}{r.report_number ? ` · No. ${r.report_number}` : ""}</p></div></div>
      {error && <p className="callout bad">{error}</p>}
      {clerk === "sent" && <p className="callout good">Sent to the clerk.</p>}
      {r.error && r.status !== "failed" && <p className="callout bad">{r.error}</p>}

      <div className="grid2">
        <section className="panel">
          <h2>What the check found</h2>
          {(r.status === "approved" || r.status === "sending") && <p className="callout info">Approved{r.approved_at ? ` ${fdt(r.approved_at)}` : ""}. {r.pdf_made_at ? "Word has made the PDF; it's being sent as soon as it reaches Drive." : <>Waiting for the office PC to make the PDF in Word{r.pdf_requested_at && Date.now() - Date.parse(r.pdf_requested_at) > 15 * 60_000 ? <b> (over 15 minutes: is the office PC on?)</b> : null}.</>}</p>}
          {r.status === "new" && <p className="muted">Waiting for the clerk to finish with it (30 minutes untouched), then it&apos;s checked automatically.</p>}
          {r.status === "checking" && <p className="muted">Being checked now…</p>}
          {r.status === "failed" && <><p className="callout bad">The check failed: {r.error}</p><form action={checkAgain.bind(null, id)}><button className="btn">Try the check again</button></form></>}
          {r.ai_summary && <p>{r.ai_summary}</p>}
          {!!issues.length && <ul className="plain">{issues.map((i, k) => <li key={k} style={{ marginBottom: 6 }}><span className={`pill ${SEV[i.severity]?.[1] ?? "muted"}`}>{SEV[i.severity]?.[0] ?? i.severity}</span> {i.text}</li>)}</ul>}
          {r.checked_at && <p className="small muted">
            {r.spelling_fixed} spelling fix{r.spelling_fixed === 1 ? "" : "es"} put in as tracked changes; issues added as comments in the Word file.
            {" "}Photos: {photos.count ?? 0}{photos.blurry ? `, ${photos.blurry} low detail` : ""}{photos.smallOnPage ? `, ${photos.smallOnPage} shown small` : ""}{photos.stretched ? `, ${photos.stretched} stretched` : ""}{photos.shrunk ? `; ${photos.shrunk} made smaller` : ""}.
            {" "}File {mb(r.size_before)} → {mb(r.size_after)}. Checked {fdt(r.checked_at)}.</p>}
          {/* open it in Word from Google Drive on your computer: opening it in Google Docs spoils the layout */}
          {r.main_folder && r.checked_name && !r.original_trashed_at && <div className="field"><label className="small muted" htmlFor="wp">The checked copy, to open in Word (on your computer, Google Drive)</label>
            <input id="wp" readOnly value={`G:\\My Drive\\Work\\${r.main_folder}\\${r.project_folder_name}\\${r.folder_name}\\Checked (dashboard)\\${r.checked_name}`} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} /></div>}
          {r.main_folder && <p className="small muted">The clerk&apos;s original is left as it was: <span style={{ fontFamily: "monospace" }}>{r.folder_name}\{r.renamed_from ?? r.file_name}</span>{r.original_trashed_at ? ` (put in Drive's bin after sending, ${fdt(r.original_trashed_at)}; it can be restored for 30 days)` : ". It goes to Drive's bin once the checked copy has been sent."}</p>}
          {r.checked_folder_id && <p><a className="btn small" href={`https://drive.google.com/drive/folders/${r.checked_folder_id}`} target="_blank" rel="noreferrer">Show the checked copy in Drive</a> <span className="small muted">(open it in Word from there, not Google Docs)</span></p>}
          <p className="small muted">In Word, open the checked copy, accept or reject the tracked changes and deal with the comments, save, then approve and send here. Anything left is accepted and the comments left out of the PDF.</p>
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

      {r.checked_at && (
        <div className="grid2">
          <section className="panel">
            <h2>What was changed {typeof r.score === "number" && <span className={`pill ${r.score >= 85 ? "good" : r.score >= 65 ? "warn" : "bad"}`} title="Quality score: how much needed fixing">{r.score}/100</span>}</h2>
            {(() => {
              const f = (r.fixes ?? {}) as { spelling?: { find: string; replace: string }[]; rotated?: number; shrunk?: number; stretched?: number; enlarged?: number; uniform?: number; side_cm?: number | null; renamed?: string | null };
              return (
                <ul className="plain small">
                  {!!f.spelling?.length && <li><b>Spelling and grammar ({f.spelling.length}):</b> {f.spelling.slice(0, 25).map((s) => `${s.find} → ${s.replace}`).join("; ")}</li>}
                  {!!f.uniform && <li><b>Photos all made the same size:</b> {f.uniform} photos, {f.side_cm} cm wide, keeping landscape and portrait (odd shapes trimmed a little from the middle; undo a crop in Word with Crop &gt; Reset)</li>}
                  {!!f.renamed && <li><b>Renamed to match the other reports in the folder:</b> {f.renamed}</li>}
                  {!!f.stretched && <li><b>Stretched photos put back in proportion:</b> {f.stretched}</li>}
                  {!!f.enlarged && <li><b>Small photos made bigger:</b> {f.enlarged}</li>}
                  {!!f.rotated && <li><b>Photos turned upright:</b> {f.rotated}</li>}
                  {!!f.shrunk && <li><b>Photos made smaller:</b> {f.shrunk} ({mb(r.size_before)} → {mb(r.size_after)})</li>}
                  {r.renamed_from && <li><b>Renamed</b> from {r.renamed_from}</li>}
                  {!f.spelling?.length && !f.uniform && !f.renamed && !f.stretched && !f.enlarged && !f.rotated && !f.shrunk && <li>Nothing needed changing.</li>}
                </ul>
              );
            })()}
          </section>
          <section className="panel">
            <h2>Email to the clerk</h2>
            {r.clerk_email_sent_at ? <p className="callout good">Sent to the clerk {fdt(r.clerk_email_sent_at)} by {nameOf(r.clerk_email_sent_by) ?? ""}.</p>
              : <p className="small muted">What had to be fixed and what to do better next time. Change anything you like, then send it, or leave it.</p>}
            {conn ? (
              <form action={sendClerkEmail.bind(null, id)} className="form">
                <div className="field"><label htmlFor="cto">To</label><input id="cto" name="to" defaultValue={(r.clerks as unknown as { email?: string } | null)?.email ?? ""} placeholder="the clerk's email" /></div>
                <div className="field"><label htmlFor="csu">Subject</label><input id="csu" name="subject" defaultValue={`Your report: ${String(r.file_name).replace(/\.docx?$/i, "")}`} /></div>
                <div className="field"><label htmlFor="cbo">Email</label><textarea id="cbo" name="body" rows={12} defaultValue={clerkNote(r, me.full_name ?? me.email)} /></div>
                <button className="btn">{r.clerk_email_sent_at ? "Send again" : "Send to the clerk"}</button>
              </form>
            ) : <textarea readOnly rows={10} style={{ width: "100%" }} defaultValue={clerkNote(r, me.full_name ?? me.email)} />}
          </section>
        </div>
      )}

      {open && (
        <section className="panel">
          <h2>Approve and send</h2>
          {!conn ? (
            <p className="callout warn">To send reports from your own email, connect it once: <Link className="btn small" href="/api/google/connect?for=me">Connect my email</Link></p>
          ) : (
            <form action={sendReport.bind(null, id)} className="form">
              <p className="small muted">Sends from {conn.email}. Word makes the PDF from the report as it is now (on the office PC), it is saved next to the Word file and attached. To change who it goes to for every report, use the project&apos;s Email lists{p && <> (<Link href={`/projects/${p.id}`}>open the project</Link>)</>}.</p>
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
