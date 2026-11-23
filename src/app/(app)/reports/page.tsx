import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Prechecks } from "./prechecks";
import { HScroll } from "./hscroll";
import { fd, fdt, today } from "@/lib/format";
import { loadHolidays, addWorkingDays, workingDaysBetween, rag } from "@/lib/reports/days";
import { refreshReports, claimReport } from "./actions";
import { scoreTrend } from "@/lib/reports/trend";
import { liveClaim, claimTime } from "@/lib/reports/claim";
import { holdOf } from "@/lib/reports/hold";
import { openRequestCounts, requestKey } from "@/lib/reports/requests";
import { createServiceClient } from "@/lib/supabase/server";
import { STANDARDS, STANDARD_KEYS, standardsShare, type StandardKey, type StandardsMet } from "@/lib/reports/standards";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Issue = { severity: "high" | "medium" | "low"; text: string };
const OPEN = ["new", "checking", "ready", "failed", "approved", "sending"];
const STATUS: Record<string, [string, string]> = {
  new: ["Waiting for the clerk to finish", "muted"], checking: ["Being checked", "info"], ready: ["Ready to check", "good"],
  failed: ["Check failed", "bad"], approved: ["Approved: PDF being made in Word", "info"], sending: ["Sending…", "info"], sent: ["Sent", "good"], done: ["Done (PDF made)", "good"], ignored: ["Skipped", "muted"],
};

/** Reports: what needs checking (red/orange/green), what's missing, and how quickly clerks and the team get them out. */
export default async function Reports({ searchParams }: { searchParams: Promise<{ who?: string; month?: string; refreshed?: string; error?: string; sent?: string }> }) {
  const me = await requireProfile();
  const { who, month, refreshed, error, sent } = await searchParams;
  const db = await createClient();
  const t = today();
  const h = await loadHolidays();
  const monthStart = /^\d{4}-\d{2}$/.test(month ?? "") ? `${month}-01` : `${t.slice(0, 7)}-01`;
  const [{ data: open }, { data: settings }, { data: staff }, { data: doneMonth }, { data: lastRun }, { data: best }, { data: recentVisits }, { data: recentReports }] = await Promise.all([
    db.from("reports").select("id,file_name,folder_name,project_id,project_folder_name,kind,visit_date,uploaded_at,status,issues,score,fixes,checker_id,claimed_by,claimed_at,hold_by,hold_at,hold_reason,modified_at,error,clerks(name),projects(name)").in("status", OPEN).order("uploaded_at"),
    db.from("report_settings").select("clerk_days,team_days").eq("id", 1).single(),
    db.from("profiles").select("id,full_name,email").order("full_name"),
    db.from("reports").select("id,clerk_id,clerk_name,visit_date,uploaded_at,done_at,sent_at,sent_by,status,issues,spelling_fixed,score,fixes,clerks(name)").in("status", ["sent", "done", ...OPEN]).gte("uploaded_at", monthStart),
    db.from("sync_runs").select("finished_at,ok,message").eq("source", "report-check").order("started_at", { ascending: false }).limit(1),
    // top 20 reports of all time (Ronan, 19 Nov 2026), only those marked out of 100 the current way
    db.from("reports").select(RANKED).not("score", "is", null).neq("status", "ignored").eq("fixes->>score_by", "parts").order("score", { ascending: false }).order("visit_date", { ascending: false, nullsFirst: false }).limit(20),
    db.from("diary_visits").select("project_id,visit_date,projects(name,stage)").eq("side", "charged").gte("visit_date", addDays(t, -14)).lte("visit_date", addDays(t, -2)),
    db.from("reports").select("project_id,uploaded_at").gte("uploaded_at", addDays(t, -16)),
  ]);
  // asked of the clerk on earlier reports and not done yet, per job (Ronan, 23 Nov 2026)
  const asks = await openRequestCounts(createServiceClient());
  const askedBefore = (r: { id: string; project_id: string | null; project_folder_name: string | null; kind: string }) => asks.filter((q) => requestKey(q) === requestKey(r) && q.asked_on_report !== r.id).length;
  const { data: helper } = await db.from("sync_files").select("modified_time,file_id").eq("key", "word_helper").maybeSingle();
  const helperSeen = helper?.modified_time ?? null;
  const helperLate = (open ?? []).some((r) => r.status === "approved") && (!helperSeen || Date.now() - Date.parse(helperSeen) > 10 * 60_000);
  const clerkDays = settings?.clerk_days ?? 1, teamDays = settings?.team_days ?? 1;
  const name = (id: string | null) => { const s = (staff ?? []).find((x) => x.id === id); return s ? (s.full_name ?? s.email).split(" ")[0] : null; };

  // the queue, with its colour: due = the team's deadline after upload
  const rows = (open ?? []).map((r) => {
    const up = r.uploaded_at.slice(0, 10);
    const due = addWorkingDays(up, teamDays, h);
    const clerkLate = r.visit_date ? Math.max(0, workingDaysBetween(r.visit_date, up, h) - clerkDays) : null;
    const issues = (r.issues ?? []) as Issue[];
    // on hold waiting for the clerk: not late or due while it's with them (Ronan, 23 Nov 2026)
    const hold = holdOf(r);
    return { ...r, hold, due, colour: hold ? "hold" : rag(due, t), clerkLate, high: issues.filter((i) => i.severity === "high").length, issueCount: issues.length };
  });
  const mine = (r: { checker_id: string | null }) => r.checker_id === me.id;
  const urgent = (a: typeof rows[number], b: typeof rows[number]) => ["red", "orange", "green", "hold"].indexOf(a.colour) - ["red", "orange", "green", "hold"].indexOf(b.colour) || a.due.localeCompare(b.due);
  // grouped by job (Ronan, 18 Nov 2026): the job with the most urgent report first, then all its other reports straight
  // underneath, oldest first; then the next job
  const filtered = rows.filter((r) => (!who ? true : who === "me" ? mine(r) : who === "none" ? !r.checker_id : r.checker_id === who));
  const jobKey = (r: typeof rows[number]) => r.project_id ?? r.project_folder_name ?? r.id;
  const jobRank = new Map<string, number>();
  [...filtered].sort(urgent).forEach((r, k) => { if (!jobRank.has(jobKey(r))) jobRank.set(jobKey(r), k); });
  // for now, Darren at Arcadis's jobs always at the very top, above older reports (Ronan, 18 Nov 2026: "until we get the
  // issue of trying to get reports out quicker"): Ilkley and Brunswick Primary School. Take out when no longer needed.
  const FIRST = new Set(["a3c42693-a734-4b24-ae31-1f2bb2c88c3c", "f55a3ed1-e81d-4c95-88bc-2edd3b935c53"]);
  const arcadis = (r: typeof rows[number]) => (r.project_id && FIRST.has(r.project_id) ? 0 : 1);
  const shown = filtered.sort((a, b) => arcadis(a) - arcadis(b) || jobRank.get(jobKey(a))! - jobRank.get(jobKey(b))!
    || (a.visit_date ?? a.uploaded_at).localeCompare(b.visit_date ?? b.uploaded_at) || a.uploaded_at.localeCompare(b.uploaded_at));
  const count = (c: string) => rows.filter((r) => r.colour === c).length;
  const checkers = [...new Set(rows.map((r) => r.checker_id).filter(Boolean))] as string[];

  // missing: a charged diary visit 2+ days ago with no report uploaded for that job since
  const missing = new Map<string, { name: string; last: string }>();
  for (const v of recentVisits ?? []) {
    const p = v.projects as unknown as { name?: string; stage?: string } | null;
    if (!v.project_id || !p || !["live", "won_preparing", "won_arranging"].includes(p.stage ?? "")) continue;
    const got = (recentReports ?? []).some((r) => r.project_id === v.project_id && r.uploaded_at.slice(0, 10) >= v.visit_date);
    if (got) continue;
    const cur = missing.get(v.project_id);
    if (!cur || cur.last < v.visit_date) missing.set(v.project_id, { name: p.name ?? "", last: v.visit_date });
  }

  // timings this month: clerks (visit → upload) and checkers (upload → sent)
  const dm = doneMonth ?? [];
  // sent reports whose feedback hasn't gone to the clerk (Andy K's list)
  const { data: feedback } = await db.from("reports").select("id,file_name,clerk_name,sent_at,score,issues,clerk_points,clerks(name)")
    .eq("status", "sent").is("clerk_email_sent_at", null).gte("sent_at", addDays(t, -30)).order("sent_at", { ascending: false }).limit(100);
  // each clerk's score trend over the last six months (getting better or worse), linking to the graph on their page
  const { data: history } = await db.from("reports").select("clerk_id,clerk_name,visit_date,checked_at,score,clerks(name)")
    .not("score", "is", null).gte("checked_at", addDays(t, -183)).order("checked_at");
  const trendOf = new Map<string, { id: string | null; scores: [string, number][] }>();
  for (const r of history ?? []) {
    const k = (r.clerks as unknown as { name?: string } | null)?.name ?? r.clerk_name ?? "Unknown";
    const x = trendOf.get(k) ?? { id: r.clerk_id as string | null, scores: [] as [string, number][] };
    x.scores.push([r.visit_date ?? r.checked_at ?? "", Number(r.score)]);
    trendOf.set(k, x);
  }
  const trendFor = (k: string) => { const x = trendOf.get(k); return x ? { id: x.id, ...scoreTrend(x.scores.sort((a, b) => a[0].localeCompare(b[0])).map(([, s]) => s)) } : null; };
  const byClerk = new Map<string, { n: number; days: number; timed: number; late: number; issues: number; spelling: number; score: number; scored: number; best: number; bestN: number; missed: Partial<Record<StandardKey, number>> }>();
  for (const r of dm) {
    const k = (r.clerks as unknown as { name?: string } | null)?.name ?? r.clerk_name ?? "Unknown";
    const x = byClerk.get(k) ?? { n: 0, days: 0, timed: 0, late: 0, issues: 0, spelling: 0, score: 0, scored: 0, best: 0, bestN: 0, missed: {} };
    if (typeof r.score === "number") { x.score += r.score; x.scored++; }
    // the team's best practices (standards.ts): how many this clerk hits, and which they miss most
    const st = (r.fixes as { standards?: StandardsMet } | null)?.standards;
    const share = standardsShare(st);
    if (share !== null) { x.best += share; x.bestN++; for (const s of STANDARD_KEYS) if (st?.[s] === false) x.missed[s] = (x.missed[s] ?? 0) + 1; }
    x.n++; x.issues += ((r.issues ?? []) as Issue[]).filter((i) => i.severity !== "low").length; x.spelling += r.spelling_fixed ?? 0;
    if (r.visit_date) { const d = workingDaysBetween(r.visit_date, r.uploaded_at.slice(0, 10), h); x.days += d; x.timed++; if (d > clerkDays) x.late++; }
    byClerk.set(k, x);
  }
  // per clerk, all time (Ronan, 19 Nov 2026: "keep it basic"): average working days from visit to upload, and average
  // score per report (only reports marked out of 100 the current way). Monthly reports have no visit date: not timed.
  // A clerk needs at least 3 reports to be ranked.
  const all: { clerk_id: string | null; clerk_name: string | null; visit_date: string | null; uploaded_at: string; score: number | null; fixes: unknown; clerks: unknown }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("reports").select("clerk_id,clerk_name,visit_date,uploaded_at,score,fixes->score_by,clerks(name)").neq("status", "ignored").order("id").range(from, from + 999);
    all.push(...((data ?? []) as unknown as typeof all).map((r) => ({ ...r, fixes: { score_by: (r as unknown as { score_by?: string }).score_by } })));
    if (!data || data.length < 1000) break;
  }
  const perClerk = new Map<string, { id: string | null; days: number; timed: number; score: number; scored: number }>();
  for (const r of all) {
    const k = (r.clerks as { name?: string } | null)?.name ?? r.clerk_name;
    if (!k) continue;
    const x = perClerk.get(k) ?? { id: r.clerk_id, days: 0, timed: 0, score: 0, scored: 0 };
    if (r.visit_date && r.visit_date <= r.uploaded_at.slice(0, 10)) { x.days += workingDaysBetween(r.visit_date, r.uploaded_at.slice(0, 10), h); x.timed++; }
    if (typeof r.score === "number" && (r.fixes as { score_by?: string }).score_by === "parts") { x.score += r.score; x.scored++; }
    perClerk.set(k, x);
  }
  const speed = [...perClerk].filter(([, x]) => x.timed >= 3).map(([k, x]) => ({ k, id: x.id, v: x.days / x.timed, n: x.timed })).sort((a, b) => a.v - b.v);
  const points = [...perClerk].filter(([, x]) => x.scored >= 3).map(([k, x]) => ({ k, id: x.id, v: x.score / x.scored, n: x.scored })).sort((a, b) => b.v - a.v);
  const byChecker = new Map<string, { n: number; days: number; late: number }>();
  for (const r of dm.filter((x) => x.sent_at && x.sent_by)) {
    const k = name(r.sent_by) ?? "?";
    const x = byChecker.get(k) ?? { n: 0, days: 0, late: 0 };
    const d = workingDaysBetween(r.uploaded_at.slice(0, 10), r.sent_at!.slice(0, 10), h);
    x.n++; x.days += d; if (d > teamDays) x.late++;
    byChecker.set(k, x);
  }
  const monthLabel = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <>
      <div className="head">
        <div><h1>Reports</h1><p>Every Word report clerks upload is checked by AI (spelling fixed as tracked changes, photos made smaller, issues noted), then checked and sent from here.</p></div>
        <div className="row"><Link className="btn primary" href="/reports/tracker">Report tracker</Link><form action={refreshReports}><button className="btn">Look for new reports now</button></form><Link className="btn" href="/reports/settings">Standard email &amp; settings</Link></div>
      </div>
      {error && <p className="callout bad">{error}</p>}
      {refreshed && <p className="callout info">Looked just now: {refreshed}.</p>}
      {sent && <p className="callout good">Approved. The office PC makes the PDF in Word, saves it next to the report and it is sent from your email, usually within a few minutes.</p>}
      {helperLate && <p className="callout warn">The PC that makes the PDFs in Word{helper?.file_id && helper.file_id !== "pc" ? ` (${helper.file_id})` : ""} hasn’t checked in {helperSeen ? `since ${fdt(helperSeen)}` : "yet"}: approved reports wait until it’s on.</p>}
      <Prechecks />
      {lastRun?.[0] && <p className="small muted">Last looked {fdt(lastRun[0].finished_at)}: {lastRun[0].ok ? lastRun[0].message : <span className="neg">{lastRun[0].message}</span>}. Every 15 minutes. Clerks have {clerkDays} working day{clerkDays === 1 ? "" : "s"} after a visit; the team {teamDays} after upload.</p>}

      <div className="tiles">
        <Link className={`tile ${count("red") ? "alert" : ""}`} href="/reports"><span className="label">🔴 Late: send now</span><span className="big">{count("red")}</span></Link>
        <Link className="tile" href="/reports"><span className="label">🟠 Due today</span><span className="big">{count("orange")}</span></Link>
        <Link className="tile" href="/reports"><span className="label">🟢 Fine for now</span><span className="big">{count("green")}</span></Link>
        <Link className="tile" href="/reports"><span className="label">⏸ On hold (with the clerk)</span><span className="big">{count("hold")}</span></Link>
        <Link className="tile" href="/reports?who=me"><span className="label">Mine</span><span className="big">{rows.filter(mine).length}</span></Link>
        <Link className={`tile ${rows.some((r) => !r.checker_id) ? "alert" : ""}`} href="/reports?who=none"><span className="label">No checker</span><span className="big">{rows.filter((r) => !r.checker_id).length}</span></Link>
      </div>
      <p className="small">{["", ...checkers].map((c) => <Link key={c || "all"} className={`btn small ${(who ?? "") === c ? "primary" : ""}`} href={c ? `/reports?who=${c}` : "/reports"} style={{ marginRight: 6 }}>{c ? name(c) : "Everyone"}</Link>)}</p>

      <section className="panel">
        {!shown.length ? <p className="empty">Nothing waiting.</p> : (
          <HScroll><table>
            <thead><tr><th /><th>Project</th><th>Report</th><th>Clerk</th><th>Visit</th><th>Uploaded</th><th>Due out</th><th>Issues</th><th className="num" title="The AI&apos;s overall score for the report, out of 100 (grey: scored the old way; check it again)">Score</th><th>Status</th><th>Checker</th></tr></thead>
            <tbody>{shown.map((r, k) => {
              const p = r.projects as unknown as { name?: string } | null;
              const [st, tone] = STATUS[r.status] ?? [r.status, "muted"];
              // the first report of each job starts a group (a line above it); the job's later reports sit under it
              const first = k === 0 || jobKey(shown[k - 1]) !== jobKey(r);
              const more = first ? shown.filter((x) => jobKey(x) === jobKey(r)).length : 0;
              return (
                <tr key={r.id} style={first && k ? { borderTop: "2px solid var(--line)" } : undefined}>
                  <td title={r.colour}>{r.colour === "hold" ? "⏸" : r.colour === "red" ? "🔴" : r.colour === "orange" ? "🟠" : "🟢"}</td>
                  <td>{first ? <><b>{p?.name ?? r.project_folder_name}</b>{more > 1 ? <span className="muted small"> · {more} reports</span> : null}{arcadis(r) === 0 ? <span className="pill warn small" title="Darren at Arcadis: kept at the top for now"> Arcadis: send first</span> : null}</> : <span className="muted small">↳ same job</span>}<span className="two">{r.folder_name}</span></td>
                  <td className="small"><Link href={`/reports/${r.id}`}>{r.file_name}</Link></td>
                  <td className="small">{(r.clerks as unknown as { name?: string } | null)?.name ?? "—"}</td>
                  <td className="small">{fd(r.visit_date)}</td>
                  <td className="small">{fd(r.uploaded_at)}{r.clerkLate ? <span className="two neg">{r.clerkLate} day{r.clerkLate === 1 ? "" : "s"} late</span> : null}</td>
                  <td className={`small ${r.colour === "red" ? "neg" : ""}`}>{fd(r.due)}</td>
                  <td className="small">{(() => { const n = askedBefore(r); return n ? <Link href={`/reports/${r.id}#asked`} className="pill warn" title="Asked of the clerk on an earlier report and not marked done: check they've acted on it" style={{ marginRight: 4 }}>🔁 {n} asked before</Link> : null; })()}{r.high ? <span className="pill bad">{r.high} must check</span> : null} {r.issueCount ? `${r.issueCount}` : r.status === "ready" ? "none" : ""}</td>
                  <td className="num">{typeof r.score === "number" ? (((r.fixes ?? {}) as { score_by?: string }).score_by === "parts"
                    ? <b className={r.score >= 85 ? "pos" : r.score < 70 ? "neg" : ""}>{r.score}</b>
                    : <span className="muted" title="Scored the old way: open it and check again">{r.score}*</span>) : ""}</td>
                  <td>{r.hold ? <span className="pill warn" title={r.hold.reason ?? ""}>⏸ On hold{r.hold.updated ? ": clerk has updated it" : ": with the clerk"}</span> : <span className={`pill ${tone}`}>{st}</span>}{r.hold?.reason && <span className="two small muted">{name(r.hold.by) ?? ""}: {r.hold.reason.slice(0, 70)}</span>}{r.status === "failed" && <span className="two small neg">{(r.error ?? "").slice(0, 60)}</span>}</td>
                  <td className="small">{name(r.checker_id) ?? <span className="pill bad">None</span>}{(() => { const c = liveClaim(r); return c ? <span className="two"><span className="pill warn" title={`Being checked by ${name(c.by)} since ${claimTime(c.at)}: leave it to them`}>🔒 {c.by === me.id ? "You're" : `${name(c.by)} is`} checking</span></span>
                    : ["new", "checking", "ready", "failed"].includes(r.status) ? <form action={claimReport.bind(null, r.id)} className="two"><button className="btn small" title="Shows the others you're checking this one, so nobody checks it twice">I&apos;m checking this</button></form> : null; })()}</td>
                </tr>
              );
            })}</tbody>
          </table></HScroll>
        )}
      </section>

      {/* Ronan, 15 Nov 2026: reports go out fast; the improvements are for Andy K to take up with the clerks afterwards */}
      <section className="panel">
        <h2>Feedback for clerks <span className="small muted">{(feedback ?? []).length}</span></h2>
        <p className="small muted">Reports already sent in the last 30 days whose feedback email hasn&apos;t gone to the clerk yet. Open one to see everything the check found and the drafted email, change it if you like, and send it from your own email.</p>
        {!(feedback ?? []).length ? <p className="empty">Nothing waiting.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Clerk</th><th>Report</th><th>Sent</th><th className="num">Score</th><th>Found</th></tr></thead>
            <tbody>{(feedback ?? []).map((r) => {
              const iss = (r.issues ?? []) as Issue[];
              return (
                <tr key={r.id}>
                  <td className="small">{(r.clerks as unknown as { name?: string } | null)?.name ?? r.clerk_name ?? "—"}</td>
                  <td className="small"><Link href={`/reports/${r.id}#clerk`}>{r.file_name}</Link></td>
                  <td className="small">{fd(r.sent_at)}</td>
                  <td className="num">{typeof r.score === "number" ? r.score : "—"}</td>
                  <td className="small">{iss.filter((i) => i.severity !== "low").length} points{((r.clerk_points ?? []) as string[]).length ? `, ${(r.clerk_points as string[]).length} suggestions` : ""}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>

      {!!missing.size && (
        <section className="panel">
          <h2>Reports not in yet</h2>
          <p className="small muted">A clerk was on site (charged in the diary) at least 2 days ago and no report has been uploaded for the job since.</p>
          <table><tbody>{[...missing].sort((a, b) => a[1].last.localeCompare(b[1].last)).map(([id, m]) => (
            <tr key={id}><td><Link href={`/projects/${id}`}>{m.name}</Link></td><td className="small">last visit {fd(m.last)}</td></tr>
          ))}</tbody></table>
        </section>
      )}

      <h2>{monthLabel(monthStart)}: how quickly reports get out</h2>
      <div className="grid2">
        <section className="panel">
          <h3>Clerks: scorecard</h3>
          <p className="small muted">Days from visit to upload, reports late, issues and spelling fixes per report, the average quality score (100 = nothing needed fixing), and how many of the team&apos;s {STANDARD_KEYS.length} best practices their reports hit, with the one they miss most.</p>
          {!byClerk.size ? <p className="empty">No reports this month yet.</p> : (
            <table><thead><tr><th>Clerk</th><th className="num">Reports</th><th className="num">Average days</th><th className="num">Late</th><th className="num">Issues per report</th><th className="num">Spelling fixes</th><th className="num" title="Average quality score out of 100: how little needed fixing">Score</th><th className="num" title={`Of the team's best practices: ${STANDARD_KEYS.map((s) => STANDARDS[s].label).join(", ")}`}>Best practice</th><th>Most missed</th><th title="Last five reports against the five before (six months); click for their graph">Trend</th></tr></thead>
              <tbody>{[...byClerk].sort((a, b) => (b[1].timed ? b[1].days / b[1].timed : 0) - (a[1].timed ? a[1].days / a[1].timed : 0)).map(([k, x]) => (
                <tr key={k}><td>{k}</td><td className="num">{x.n}</td><td className={`num ${x.timed && x.days / x.timed > clerkDays ? "neg" : ""}`}>{x.timed ? (x.days / x.timed).toFixed(1) : "—"}</td>
                  <td className={`num ${x.late ? "neg" : ""}`}>{x.late}</td><td className="num">{(x.issues / x.n).toFixed(1)}</td><td className="num">{x.spelling}</td><td className={`num ${x.scored && x.score / x.scored < 65 ? "neg" : ""}`}>{x.scored ? Math.round(x.score / x.scored) : "—"}</td>
                  <td className={`num ${x.bestN && x.best / x.bestN < 0.6 ? "neg" : ""}`}>{x.bestN ? `${Math.round((x.best / x.bestN) * STANDARD_KEYS.length)}/${STANDARD_KEYS.length}` : "—"}</td>
                  <td className="small">{(() => { const top = (Object.entries(x.missed) as [StandardKey, number][]).sort((a, b) => b[1] - a[1])[0]; return top ? STANDARDS[top[0]].label : "—"; })()}</td>
                  <td className="small">{(() => { const tr = trendFor(k); if (!tr) return "—"; const label = { up: "↑ better", down: "↓ worse", steady: "→ steady", new: "too few yet" }[tr.dir];
                    const el = <span className={tr.dir === "down" ? "neg" : tr.dir === "up" ? "pos" : "muted"}>{label}</span>; return tr.id ? <Link href={`/personnel/${tr.id}`}>{el}</Link> : el; })()}</td></tr>
              ))}</tbody></table>
          )}
        </section>
        <section className="panel">
          <h3>Team: upload to sent</h3>
          {!byChecker.size ? <p className="empty">Nothing sent from the dashboard this month yet.</p> : (
            <table><thead><tr><th>Sent by</th><th className="num">Reports</th><th className="num">Average days</th><th className="num">Late</th></tr></thead>
              <tbody>{[...byChecker].map(([k, x]) => (
                <tr key={k}><td>{k}</td><td className="num">{x.n}</td><td className={`num ${x.days / x.n > teamDays ? "neg" : ""}`}>{(x.days / x.n).toFixed(1)}</td><td className={`num ${x.late ? "neg" : ""}`}>{x.late}</td></tr>
              ))}</tbody></table>
          )}
        </section>
      </div>

      <h2>Clerks to date</h2>
      <div className="grid2">
        <ClerkList title="Quickest to send reports in" unit="days" rows={speed.slice(0, 10)} fmt={(v) => `${v.toFixed(1)} days`} />
        <ClerkList title="Slowest to send reports in" unit="days" rows={speed.slice(-10).reverse()} fmt={(v) => `${v.toFixed(1)} days`} bad />
        <ClerkList title="Highest average score" unit="score" rows={points.slice(0, 10)} fmt={(v) => `${Math.round(v)}`} />
        <ClerkList title="Lowest average score" unit="score" rows={points.slice(-10).reverse()} fmt={(v) => `${Math.round(v)}`} bad />
      </div>
      <p className="small muted">Average working days from the visit to the report being uploaded, and average score out of 100 per report. Clerks with at least 3 reports.</p>
      <Ranked title="Top 20 reports of all time" rows={best ?? []} />
    </>
  );
}

const RANKED = "id,score,report_number,visit_date,uploaded_at,file_name,clerk_name,project_folder_name,clerks(name),projects(name)";
type RankedRow = { id: string; score: number | null; report_number: string | null; visit_date: string | null; uploaded_at: string; file_name: string; clerk_name: string | null; project_folder_name: string | null; clerks: unknown; projects: unknown };

/** A short ranked list of clerks: name and one figure. */
function ClerkList({ title, rows, fmt, bad }: { title: string; unit: string; rows: { k: string; id: string | null; v: number; n: number }[]; fmt: (v: number) => string; bad?: boolean }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {!rows.length ? <p className="empty">Not enough reports yet.</p> : (
        <table><tbody>{rows.map((r, k) => (
          <tr key={r.k}><td className="num muted">{k + 1}</td><td>{r.id ? <Link href={`/personnel/${r.id}`}>{r.k}</Link> : r.k}</td>
            <td className={`num ${bad ? "neg" : "pos"}`}><b>{fmt(r.v)}</b></td><td className="num small muted">{r.n} reports</td></tr>
        ))}</tbody></table>
      )}
    </section>
  );
}

/** A simple list of reports by score: clerk, report number, project, date and score. */
function Ranked({ title, rows }: { title: string; rows: RankedRow[] }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {!rows.length ? <p className="empty">No scored reports yet.</p> : (
        <table><thead><tr><th className="num">#</th><th>Clerk</th><th>Report</th><th>Project</th><th>Date</th><th className="num">Score</th></tr></thead>
          <tbody>{rows.map((r, k) => (
            <tr key={r.id}>
              <td className="num muted">{k + 1}</td>
              <td className="small">{(r.clerks as { name?: string } | null)?.name ?? r.clerk_name ?? "—"}</td>
              <td className="small"><Link href={`/reports/${r.id}`} title={r.file_name}>{r.report_number ? `No. ${r.report_number.replace(/^(no\.?|r)\s*/i, "")}` : "open"}</Link></td>
              <td className="small">{(r.projects as { name?: string } | null)?.name ?? r.project_folder_name ?? "—"}</td>
              <td className="small">{fd(r.visit_date ?? r.uploaded_at)}</td>
              <td className={`num ${(r.score ?? 0) >= 85 ? "pos" : (r.score ?? 0) < 70 ? "neg" : ""}`}><b>{r.score}</b></td>
            </tr>
          ))}</tbody></table>
      )}
    </section>
  );
}

function addDays(d: string, n: number) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
