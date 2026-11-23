import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { fd, fdt } from "@/lib/format";
import { draftFor } from "@/lib/reports/pipeline";
import { userConnection } from "@/lib/google-user";
import { EXAMPLES, PROGRAMME_METHOD, SUMMARY_METHOD } from "@/lib/reports/examples";
import { STANDARDS, STANDARD_KEYS, tipFor, type StandardsMet } from "@/lib/reports/standards";
import type { ScorePart } from "@/lib/reports/score";
import { assignChecker, sendReport, markDone, ignoreReport, checkAgain, sendClerkEmail, setVisitDate, claimReport, releaseReport, makeCleanPdf } from "../actions";
import { liveClaim, claimTime, CLAIM_HOURS } from "@/lib/reports/claim";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Issue = { severity: "high" | "medium" | "low"; kind: string; text: string; near?: string | null; page?: number | null };

/** A friendly note to the clerk: what had to be fixed in this report and what to do next time. */
function clerkNote(r: Record<string, unknown>, sender: string) {
  const clerk = ((r.clerks as { name?: string } | null)?.name ?? (r.clerk_name as string | null) ?? "").split(" ")[0];
  const f = (r.fixes ?? {}) as { spelling?: { find: string; replace: string }[]; rotated?: number; shrunk?: number; stretched?: number; enlarged?: number; uniform?: number; mixed?: boolean; side_cm?: number | null; renamed?: string | null };
  // things raised for the checker that a suggestion below already covers aren't repeated
  const issues = ((r.issues ?? []) as Issue[]).filter((i) => i.severity !== "low" && i.kind !== "safety" && i.kind !== "programme" && i.kind !== "template" && !/^(Health and safety|Issues tracker):/.test(i.text));
  // what was put right goes back to the clerk (Ronan, 15 Nov 2026), worded gently: "steer them in the right
  // direction rather than saying do this or else"
  const fixed = [
    // every correction, so the clerk can see each mistake (Ronan, 16 Nov 2026); made straight into the text, no tracked changes (18 Nov 2026)
    f.spelling?.length ? `${f.spelling.length} spelling/grammar correction${f.spelling.length === 1 ? "" : "s"}: ${f.spelling.map((s) => `"${s.find}" → "${s.replace}"`).join(", ")}` : null,
    f.renamed ? `the file name, to match the other reports in the folder (now "${f.renamed}")` : null,
    f.mixed ? `the photos, now all the same size (about ${f.side_cm ?? 6} cm wide)` : null,
    f.stretched ? `${f.stretched} photo${f.stretched === 1 ? "" : "s"} that had stretched out of shape` : null,
    f.enlarged ? `${f.enlarged} photo${f.enlarged === 1 ? "" : "s"} that were a bit small to see on the page` : null,
    f.rotated ? `${f.rotated} photo${f.rotated === 1 ? "" : "s"} that were on their side` : null,
    f.shrunk ? `the photo sizes, to bring the file down from ${(Number(r.size_before) / 1e6).toFixed(0)} MB` : null,
  ].filter(Boolean) as string[];
  const allIssues = (r.issues ?? []) as Issue[];
  // Ronan's progress vs programme method, pushed whenever a report falls short of it (his email to all clerks, Aug 2024)
  const programmeIssue = allIssues.some((i) => i.kind === "programme" && i.severity !== "low");
  const dfe = ((f as { programme?: { dfe?: boolean } | null }).programme?.dfe) !== false;
  const programmeHelp = programmeIssue && dfe, summaryHelp = programmeIssue && !dfe;
  const st = (f as { standards?: StandardsMet | null }).standards ?? {};
  // the DfE form can't be changed, so its tips say which box to use rather than what to add (Ronan, 15 Nov 2026)
  const onDfeForm = (f as { programme?: { dfe?: boolean } | null }).programme?.dfe === true;
  const missed = STANDARD_KEYS.filter((s) => st[s] === false && !(s === "summary" && summaryHelp));
  const tips = ((r.clerk_points ?? []) as string[]).filter((t) => t && !(programmeIssue && /^(Progress (vs programme|summary)|On the (progress vs programme section|progress summary))/i.test(t)));
  const photoHelp = !!(f.mixed || f.stretched || f.enlarged || allIssues.some((i) => i.kind === "photos" && i.severity !== "low"));
  const detailHelp = allIssues.some((i) => i.kind === "vague" && i.severity !== "low");
  // start with what they do well
  const strengths = STANDARD_KEYS.filter((s) => st[s] === true).map((s) => STANDARDS[s].label.toLowerCase());
  const praise = strengths.length >= 2 ? ` It's good to see ${strengths.slice(0, -1).slice(0, 2).join(", ")} and ${strengths[strengths.length - 1]} in there.` : "";
  if (!fixed.length && !tips.length && !missed.length && !issues.length) return `Hi ${clerk},\n\nThanks for your report (${r.file_name}). It needed no changes before it went out. Great work.${praise}\n\nKind regards,\n${sender}`;
  return [
    `Hi ${clerk},`, "",
    `Thanks for your report (${r.file_name}).${praise}`,
    ...(fixed.length ? ["", "We tidied up a few small things before it went to the client:", ...fixed.map((x) => `- ${x}`)] : []),
    ...(issues.length ? ["", "A couple of things we noticed:", ...issues.map((i) => `- ${i.text}`)] : []),
    ...(tips.length ? ["", "A few suggestions for your next reports:", ...tips.map((x) => `- ${x}`)] : []),
    // pictures from Christian's report where they'd help (the line becomes the picture when it's sent)
    ...(photoHelp ? ["", EXAMPLES.photos.intro, EXAMPLES.photos.marker] : []),
    ...(detailHelp ? ["", EXAMPLES.detail.intro, EXAMPLES.detail.marker] : []),
    ...(programmeHelp ? ["", "Clients read the progress vs programme section closely, so it's well worth getting right. This is the approach that works well:", ...PROGRAMME_METHOD, "", EXAMPLES.programme.intro, EXAMPLES.programme.marker] : []),
    ...(summaryHelp ? ["", ...SUMMARY_METHOD] : []),
    // the best bits of everyone's reports this one doesn't do yet (standards.ts)
    ...(missed.length ? ["", "We're bringing together the best bits of everyone's reports so we all work the same way. A few ideas that would make yours even better:", ...missed.map((s) => `- ${tipFor(s, onDfeForm)}`)] : []),
    "", "Thanks again. Any questions, just give me a shout.", "", "Kind regards,", sender,
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
  // checked in the clerk's own file (from 16 Nov 2026) rather than a copy in "Checked (dashboard)"
  const pagesState = (r.fixes as { pages_state?: string } | null)?.pages_state ?? null;
  const inPlace = !!r.checked_file_id && r.checked_file_id === r.drive_file_id;
  const photos = (r.photos ?? {}) as { count?: number; blurry?: number; smallOnPage?: number; stretched?: number; shrunk?: number };
  const mb = (n: number | null) => (n ? `${(n / 1e6).toFixed(1)} MB` : "—");
  const open = ["new", "checking", "ready", "failed"].includes(r.status);
  const claim = liveClaim(r);
  const nameOf = (pid: string | null) => (staff ?? []).find((s) => s.id === pid)?.full_name ?? null;
  const scoreParts = (((r.fixes ?? {}) as { score_parts?: ScorePart[] }).score_parts ?? []);

  return (
    <>
      <p className="small"><Link href="/reports">Reports</Link>{p && <> · <Link href={`/projects/${p.id}`}>{p.name}</Link></>}</p>
      <div className="head"><div><h1 style={{ wordBreak: "break-word" }}>{r.file_name}</h1>
        <p>{p?.name ?? r.project_folder_name} · {r.folder_name} · {(r.clerks as unknown as { name?: string } | null)?.name ?? r.clerk_name ?? "clerk not known"}{r.report_number ? ` · No. ${r.report_number}` : ""}</p></div>
        {/* the report's mark, up front (Ronan, 16 Nov 2026: "where do I see that?") */}
        {typeof r.score === "number" && (scoreParts.length
          ? <div className="tile" style={{ minWidth: 150, textAlign: "center" }} title="Marked on the report as the clerk sent it, before any corrections: see How the score was worked out"><span className="label">Report score</span><span className={`big ${r.score >= 85 ? "pos" : r.score < 70 ? "neg" : ""}`}>{r.score}<small className="muted">/100</small></span></div>
          : <div className="tile" style={{ minWidth: 150, textAlign: "center" }} title="Scored the old way, so it isn't comparable. It'll be re-checked."><span className="label">Report score</span><span className="big muted">{r.score}<small>/100</small></span><span className="small muted">old scoring</span></div>)}
      </div>
      {/* someone else checking it for now (Ronan, 20 Nov 2026): "don't check that one, Andy K is checking it" */}
      {open && (claim && claim.by !== me.id ? (
        <div className="callout warn row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span><b>{nameOf(claim.by) ?? "Someone"} is checking this report</b> (since {claimTime(claim.at)}). Leave it to them?</span>
          <form action={claimReport.bind(null, id)}><button className="btn small">Take it over</button></form>
        </div>
      ) : claim ? (
        <div className="callout info row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span>You&apos;re checking this report (since {claimTime(claim.at)}): the others see it&apos;s yours for now.</span>
          <form action={releaseReport.bind(null, id)}><button className="btn small">Stop checking</button></form>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, alignItems: "center", margin: "6px 0 12px" }}>
          <form action={claimReport.bind(null, id)}><button className="btn">I&apos;m checking this</button></form>
          <span className="small muted">Shows the others you&apos;re on it (for up to {CLAIM_HOURS} hours, or until it&apos;s sent), so nobody checks it twice.</span>
        </div>
      ))}
      {/* how the mark was made up (Ronan, 16 Nov 2026): information 40, then 10 each for the rest */}
      {!!scoreParts.length && (
        <section className="panel">
          <h2>How the score was worked out <span className="small muted">on the report as the clerk sent it, before any corrections</span></h2>
          <table><tbody>{scoreParts.map((s) => (
            <tr key={s.label}><td>{s.label}</td><td className={`num ${s.got >= s.of * 0.85 ? "pos" : s.got < s.of * 0.6 ? "neg" : ""}`}><b>{s.got}</b> / {s.of}</td><td className="small"><span className="muted">{s.note}</span>{s.improve && s.got < s.of && <span className="two">{s.improve}</span>}</td></tr>
          ))}<tr><td><b>Total</b></td><td className="num"><b>{r.score}</b> / 100</td><td /></tr></tbody></table>
        </section>
      )}
      {error && <p className="callout bad">{error}</p>}
      {clerk === "sent" && <p className="callout good">Sent to the clerk.</p>}
      {/* the note says "Check again", so the button is right beside it (Ronan, 20 Nov 2026: "we don't know where the check again button is") */}
      {r.error && r.status !== "failed" && (
        <div className="callout bad row" style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span>{r.error}</span>
          {open && <form action={checkAgain.bind(null, id)}><button className="btn small">Check again</button></form>}
        </div>
      )}

      <div className="grid2">
        <section className="panel">
          <h2>What the check found</h2>
          {(r.status === "approved" || r.status === "sending") && <p className="callout info">Approved{r.approved_at ? ` ${fdt(r.approved_at)}` : ""}. {r.pdf_made_at ? ((r.pending_email as { pdfOnly?: boolean } | null)?.pdfOnly ? "Word has made the PDF; it's saved beside the report (not emailed)." : "Word has made the PDF; it's being sent as soon as it reaches Drive.") : <>Waiting for the office PC to make the PDF in Word{r.pdf_requested_at && Date.now() - Date.parse(r.pdf_requested_at) > 15 * 60_000 ? <b> (over 15 minutes: is the office PC on?)</b> : null}.</>}</p>}
          {r.status === "new" && <p className="muted">Waiting for the clerk to finish with it (30 minutes untouched), then it&apos;s checked automatically.</p>}
          {r.status === "checking" && <p className="muted">Being checked now…</p>}
          {r.status === "failed" && <><p className="callout bad">The check failed: {r.error}</p><form action={checkAgain.bind(null, id)}><button className="btn">Try the check again</button></form></>}
          {r.status === "ready" && typeof r.score === "number" && !scoreParts.length && (
            <form action={checkAgain.bind(null, id)} className="callout"><span className="small">This report was checked with the old rules. Check it again for the new score (the checked copy is made afresh, so do this before changing it by hand).</span> <button className="btn small">Check again</button></form>
          )}
          {(() => {
            // did the clerk use last week's checked report as the template? Green or red so the office sees it at a
            // glance (Ronan, 16 Nov 2026)
            const t = (r.fixes as { template?: { started: string; undone: string[]; layout: string[]; formatting: string[]; against: { id: string; number: string | null; name: string } } | null } | null)?.template;
            if (!t) return null;
            const ref = <a href={`/reports/${t.against.id}`}>{t.against.number ? `report ${t.against.number}` : "the last report"}</a>;
            const lost = t.started === "no" || t.started === "older" || t.undone.length > 0;
            const tone = lost ? "bad" : t.started === "yes" ? "good" : "info";
            return <div className={`callout ${tone}`} style={{ borderLeft: "6px solid currentColor" }}>
              <b>{lost
                ? <>✗ Didn&apos;t use the last report as the template</>
                : t.started === "yes" ? <>✓ Used the last report as the template</> : <>Template: can&apos;t tell if the last report was used</>}</b>
              {" "}<span className="small">({t.started === "older" ? <>started from an older copy of {ref}</> : <>compared with {ref}</>}{t.started === "unknown" ? "; the last one wasn't saved by Word" : ""})</span>
              {!!t.undone.length && <div className="small" style={{ marginTop: 4 }}>The office&apos;s changes that didn&apos;t carry over: {t.undone.join("; ")}</div>}
              {!!t.layout.length && <div className="small" style={{ marginTop: 4 }}>Layout differences: {t.layout.join("; ")}</div>}
              {!!t.formatting.length && <div className="small" style={{ marginTop: 4 }}><b>Formatting the last report didn&apos;t have:</b> {t.formatting.join("; ")}</div>}
            </div>;
          })()}
          {r.ai_summary && <p>{r.ai_summary}</p>}
          {/* the points to look at, in page order (Ronan, 16 Nov 2026: here with page numbers, not as comments in the
              Word file). Points about the whole report come first. */}
          {!!issues.length && <table className="issues"><tbody>{[...issues].sort((a, b) => (a.near ? (a.page ?? 9999) : -1) - (b.near ? (b.page ?? 9999) : -1)).map((i, k) => (
            <tr key={k}>
              <td style={{ width: 82, whiteSpace: "nowrap", verticalAlign: "top" }}><b>{i.near ? (i.page ? `Page ${i.page}` : pagesState === "waiting" ? "Page …" : "Page ?") : "Whole report"}</b></td>
              <td style={{ verticalAlign: "top" }}><span className={`pill ${SEV[i.severity]?.[1] ?? "muted"}`}>{SEV[i.severity]?.[0] ?? i.severity}</span> {i.text}
                {i.near && <span className="two small muted">Look for: &ldquo;{i.near}&rdquo;</span>}</td>
            </tr>
          ))}</tbody></table>}
          {pagesState === "waiting" && issues.some((i) => i.near) && <p className="small muted">Page numbers come from Word on the office PC, usually within a few minutes of the check. Until then, search in Word for the words shown (Ctrl+F).</p>}
          {r.checked_at && <p className="small muted">
            {r.spelling_fixed} spelling fix{r.spelling_fixed === 1 ? "" : "es"} made straight into the Word file, with no tracked changes, so it reads as the clerk wrote it (each one is listed under What was changed). The points above aren&apos;t put in the file.
            {" "}Photos: {photos.count ?? 0}{photos.blurry ? `, ${photos.blurry} low detail` : ""}{photos.smallOnPage ? `, ${photos.smallOnPage} shown small` : ""}{photos.stretched ? `, ${photos.stretched} stretched` : ""}{photos.shrunk ? `; ${photos.shrunk} made smaller` : ""}.
            {" "}File {mb(r.size_before)} → {mb(r.size_after)}. Checked {fdt(r.checked_at)}.</p>}
          {/* edit it in the project folder on your own computer (Ronan, 16 Nov 2026): no download or open-in-Drive
              buttons, which confused people because that's not where the report is edited */}
          {r.main_folder && r.checked_name && !r.original_trashed_at && <div className="callout info">
            <b>Edit the report in the project folder.</b> Open it in Word from the project&apos;s folder on your computer, make your changes, save, then come back here to approve and send.
            <div className="field" style={{ marginTop: 8 }}><label className="small muted" htmlFor="wp">Where it is</label>
              <input id="wp" readOnly value={`G:\\My Drive\\Work\\${r.main_folder}\\${r.project_folder_name}\\${r.folder_name}\\${inPlace ? "" : "Checked (dashboard)\\"}${r.checked_name}`} style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }} /></div>
            {r.folder_id && <p className="small" style={{ margin: "6px 0 0" }}><a href={`https://drive.google.com/drive/folders/${r.folder_id}`} target="_blank" rel="noreferrer">See the folder in Google Drive</a> <span className="muted">(to find it; edit it from the project folder on your computer)</span></p>}
          </div>}
          {r.main_folder && (inPlace
            ? <p className="small muted">Checked in the clerk&apos;s own file, in its folder{r.renamed_from ? ` (renamed from ${r.renamed_from})` : ""}. The version the clerk uploaded is kept in Drive (File information → Manage versions), and Check again starts from it. Spelling is corrected straight into the text (no red tracked changes); every correction is listed here.</p>
            : <p className="small muted">The clerk&apos;s original is left as it was until the report is sent: <span style={{ fontFamily: "monospace" }}>{r.folder_name}\{r.renamed_from ?? r.file_name}</span>{r.original_trashed_at ? ` (overwritten with the checked version when it was sent, ${fdt(r.original_trashed_at)}; Drive keeps the old version under File information → Manage versions)` : ". When it's sent, the checked version (tracked spelling changes kept, comments taken out) is written over it."}</p>)}
          <p className="small muted">Open the report in Word from the project folder and go through the points above page by page (spelling is already corrected in the text: the list under What was changed shows each one, so you can put any back by hand), make any changes, save, then approve and send here. The PDF and the clerk&apos;s file are both clean: no tracked changes or comments.</p>
        </section>

        <section className="panel">
          <h2>Details</h2>
          <table><tbody>
            <tr><td className="muted small">Visit date</td><td>
              <form action={setVisitDate.bind(null, r.id)} className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input type="date" name="visit_date" defaultValue={r.visit_date ?? ""} aria-label="Visit date" />
                <button className="btn">Save</button>
                <span className="small muted">{({ report: "read from the report", name: "from the file name", "name+diary": "from the file name and the diary", diary: "the job's last diary visit before the upload", manual: "set by hand", monthly: "monthly report: no visit date" } as Record<string, string>)[r.visit_date_source ?? ""] ?? ""}</span>
              </form></td></tr>
            <tr><td className="muted small">Uploaded</td><td>{fdt(r.uploaded_at)}</td></tr>
            {r.issued_on && <tr><td className="muted small">Date issued to TA</td><td>{fd(r.issued_on)} <span className="small muted">put in the report when it was approved</span></td></tr>}
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
            <h2>What was changed {typeof r.score === "number" && <span className={`pill ${r.score >= 85 ? "good" : r.score >= 70 ? "warn" : "bad"}`} title="Overall quality of the report, judged as a whole">{r.score}/100</span>}</h2>
            {(() => {
              const f = (r.fixes ?? {}) as { spelling?: { find: string; replace: string }[]; rotated?: number; shrunk?: number; stretched?: number; enlarged?: number; uniform?: number; side_cm?: number | null; renamed?: string | null };
              return (
                <ul className="plain small">
                  {!!f.spelling?.length && <li><b>Spelling and grammar ({f.spelling.length}):</b> {f.spelling.map((s) => `${s.find} → ${s.replace}`).join("; ")}</li>}
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
          <section className="panel" id="clerk">
            <h2>Email to the clerk</h2>
            {r.clerk_email_sent_at ? <p className="callout good">Sent to the clerk {fdt(r.clerk_email_sent_at)} by {nameOf(r.clerk_email_sent_by) ?? ""}.</p>
              : <p className="small muted">What had to be fixed and what to do better next time, with example pictures where they help (each [Example – …] line becomes the picture; delete the line to leave it out). It never names other clerks or their reports. Change anything you like, then send it, or leave it.</p>}
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

      {/* a done report whose PDF was made by hand (Brunswick 35 had the tracked changes showing): make it again, clean */}
      {r.status === "done" && r.main_folder && (r.checked_file_id || r.drive_file_id) && (
        <section className="panel">
          <h2>PDF</h2>
          <p className="small muted">If this report&apos;s PDF shows red markup (the spelling fixes as tracked changes), the office PC can make it again with the fixes accepted and save it over the old one, next to the report. Nothing is emailed.</p>
          <form action={makeCleanPdf.bind(null, id)}><button className="btn">Make a clean PDF</button></form>
        </section>
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
            <form action={checkAgain.bind(null, id)}><button className="btn small" title="Checks the report again as it is in Drive now (e.g. after the clerk has fixed it); changes made in Word here are kept">Check again</button></form>
            <form action={markDone.bind(null, id)}><button className="btn small">Already sent another way</button></form>
            <form action={makeCleanPdf.bind(null, id)}><button className="btn small" title="The office PC makes the PDF in Word with the spelling fixes accepted (no red markup) and saves it beside the report. Nothing is emailed; the report is then marked done.">Make a clean PDF (no email)</button></form>
            <form action={ignoreReport.bind(null, id)}><button className="btn small">Not a report: skip it</button></form>
          </div>
        </section>
      )}
    </>
  );
}
