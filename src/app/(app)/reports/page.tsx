import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, fdt, today } from "@/lib/format";
import { loadHolidays, addWorkingDays, workingDaysBetween, rag } from "@/lib/reports/days";
import { refreshReports } from "./actions";
import { scoreTrend } from "@/lib/reports/trend";
import { STANDARDS, STANDARD_KEYS, standardsShare, type StandardKey, type StandardsMet } from "@/lib/reports/standards";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Turn = { month: string; clerk: string; reports: number; avg_days: number; over_two_days: number; review_required: number; total_days: number; timed: number };
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
  const [{ data: open }, { data: settings }, { data: staff }, { data: doneMonth }, { data: lastRun }, { data: turn }, { data: recentVisits }, { data: recentReports }] = await Promise.all([
    db.from("reports").select("id,file_name,folder_name,project_id,project_folder_name,kind,visit_date,uploaded_at,status,issues,score,fixes,checker_id,error,clerks(name),projects(name)").in("status", OPEN).order("uploaded_at"),
    db.from("report_settings").select("clerk_days,team_days").eq("id", 1).single(),
    db.from("profiles").select("id,full_name,email").order("full_name"),
    db.from("reports").select("id,clerk_id,clerk_name,visit_date,uploaded_at,done_at,sent_at,sent_by,status,issues,spelling_fixed,score,fixes,clerks(name)").in("status", ["sent", "done", ...OPEN]).gte("uploaded_at", monthStart),
    db.from("sync_runs").select("finished_at,ok,message").eq("source", "report-check").order("started_at", { ascending: false }).limit(1),
    db.from("report_turnaround").select("*").gte("month", new Date(Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 6, 1)).toISOString().slice(0, 10)),
    db.from("diary_visits").select("project_id,visit_date,projects(name,stage)").eq("side", "charged").gte("visit_date", addDays(t, -14)).lte("visit_date", addDays(t, -2)),
    db.from("reports").select("project_id,uploaded_at").gte("uploaded_at", addDays(t, -16)),
  ]);
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
    return { ...r, due, colour: rag(due, t), clerkLate, high: issues.filter((i) => i.severity === "high").length, issueCount: issues.length };
  });
  const mine = (r: { checker_id: string | null }) => r.checker_id === me.id;
  const shown = rows.filter((r) => (!who ? true : who === "me" ? mine(r) : who === "none" ? !r.checker_id : r.checker_id === who))
    .sort((a, b) => ["red", "orange", "green"].indexOf(a.colour) - ["red", "orange", "green"].indexOf(b.colour) || a.due.localeCompare(b.due));
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
  // clerks getting their reports in on time, last three months (Ronan, 17 Nov 2026): due clerkDays working days after
  // the visit; days late = working days past that. Monthly reports have no visit date and don't count.
  const { data: q3 } = await db.from("reports").select("id,clerk_id,clerk_name,visit_date,uploaded_at,file_name,clerks(name)")
    .not("visit_date", "is", null).gte("uploaded_at", addDays(t, -92)).order("uploaded_at", { ascending: false });
  const punctual = new Map<string, { id: string | null; n: number; onTime: number; lateDays: number; worst: number; recentN: number; recentOn: number; lastLate: { file: string; days: number; up: string } | null }>();
  const monthAgo = addDays(t, -30);
  for (const r of q3 ?? []) {
    const k = (r.clerks as unknown as { name?: string } | null)?.name ?? r.clerk_name ?? "Unknown";
    const x = punctual.get(k) ?? { id: r.clerk_id as string | null, n: 0, onTime: 0, lateDays: 0, worst: 0, recentN: 0, recentOn: 0, lastLate: null };
    const late = Math.max(0, workingDaysBetween(r.visit_date!, r.uploaded_at.slice(0, 10), h) - clerkDays);
    x.n++; if (!late) x.onTime++; x.lateDays += late; x.worst = Math.max(x.worst, late);
    if (r.uploaded_at >= monthAgo) { x.recentN++; if (!late) x.recentOn++; }
    if (late && !x.lastLate) x.lastLate = { file: r.file_name, days: late, up: r.uploaded_at };
    punctual.set(k, x);
  }
  const punctualRows = [...punctual].filter(([k]) => k !== "Unknown").sort((a, b) => a[1].onTime / a[1].n - b[1].onTime / b[1].n || b[1].lateDays - a[1].lateDays);
  const byChecker = new Map<string, { n: number; days: number; late: number }>();
  for (const r of dm.filter((x) => x.sent_at && x.sent_by)) {
    const k = name(r.sent_by) ?? "?";
    const x = byChecker.get(k) ?? { n: 0, days: 0, late: 0 };
    const d = workingDaysBetween(r.uploaded_at.slice(0, 10), r.sent_at!.slice(0, 10), h);
    x.n++; x.days += d; if (d > teamDays) x.late++;
    byChecker.set(k, x);
  }
  const monthLabel = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const tr = ((turn ?? []) as Turn[]).filter((x) => x.month === monthStart).sort((x, y) => y.avg_days - x.avg_days);

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
      {lastRun?.[0] && <p className="small muted">Last looked {fdt(lastRun[0].finished_at)}: {lastRun[0].ok ? lastRun[0].message : <span className="neg">{lastRun[0].message}</span>}. Every 15 minutes. Clerks have {clerkDays} working day{clerkDays === 1 ? "" : "s"} after a visit; the team {teamDays} after upload.</p>}

      <div className="tiles">
        <Link className={`tile ${count("red") ? "alert" : ""}`} href="/reports"><span className="label">🔴 Late: send now</span><span className="big">{count("red")}</span></Link>
        <Link className="tile" href="/reports"><span className="label">🟠 Due today</span><span className="big">{count("orange")}</span></Link>
        <Link className="tile" href="/reports"><span className="label">🟢 Fine for now</span><span className="big">{count("green")}</span></Link>
        <Link className="tile" href="/reports?who=me"><span className="label">Mine</span><span className="big">{rows.filter(mine).length}</span></Link>
        <Link className={`tile ${rows.some((r) => !r.checker_id) ? "alert" : ""}`} href="/reports?who=none"><span className="label">No checker</span><span className="big">{rows.filter((r) => !r.checker_id).length}</span></Link>
      </div>
      <p className="small">{["", ...checkers].map((c) => <Link key={c || "all"} className={`btn small ${(who ?? "") === c ? "primary" : ""}`} href={c ? `/reports?who=${c}` : "/reports"} style={{ marginRight: 6 }}>{c ? name(c) : "Everyone"}</Link>)}</p>

      <section className="panel">
        {!shown.length ? <p className="empty">Nothing waiting.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th /><th>Project</th><th>Report</th><th>Clerk</th><th>Visit</th><th>Uploaded</th><th>Due out</th><th>Issues</th><th className="num" title="The AI&apos;s overall score for the report, out of 100 (grey: scored the old way; check it again)">Score</th><th>Status</th><th>Checker</th></tr></thead>
            <tbody>{shown.map((r) => {
              const p = r.projects as unknown as { name?: string } | null;
              const [st, tone] = STATUS[r.status] ?? [r.status, "muted"];
              return (
                <tr key={r.id}>
                  <td title={r.colour}>{r.colour === "red" ? "🔴" : r.colour === "orange" ? "🟠" : "🟢"}</td>
                  <td><b>{p?.name ?? r.project_folder_name}</b><span className="two">{r.folder_name}</span></td>
                  <td className="small"><Link href={`/reports/${r.id}`}>{r.file_name}</Link></td>
                  <td className="small">{(r.clerks as unknown as { name?: string } | null)?.name ?? "—"}</td>
                  <td className="small">{fd(r.visit_date)}</td>
                  <td className="small">{fd(r.uploaded_at)}{r.clerkLate ? <span className="two neg">{r.clerkLate} day{r.clerkLate === 1 ? "" : "s"} late</span> : null}</td>
                  <td className={`small ${r.colour === "red" ? "neg" : ""}`}>{fd(r.due)}</td>
                  <td className="small">{r.high ? <span className="pill bad">{r.high} must check</span> : null} {r.issueCount ? `${r.issueCount}` : r.status === "ready" ? "none" : ""}</td>
                  <td className="num">{typeof r.score === "number" ? (((r.fixes ?? {}) as { score_by?: string }).score_by === "parts"
                    ? <b className={r.score >= 85 ? "pos" : r.score < 70 ? "neg" : ""}>{r.score}</b>
                    : <span className="muted" title="Scored the old way: open it and check again">{r.score}*</span>) : ""}</td>
                  <td><span className={`pill ${tone}`}>{st}</span>{r.status === "failed" && <span className="two small neg">{(r.error ?? "").slice(0, 60)}</span>}</td>
                  <td className="small">{name(r.checker_id) ?? <span className="pill bad">None</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
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

      <section className="panel">
        <h2>Clerks: reports in on time <span className="small muted">last 3 months</span></h2>
        <p className="small muted">A report is due {clerkDays} working day{clerkDays === 1 ? "" : "s"} after the visit (weekends and bank holidays don&apos;t count). The visit date is the one written in the report, or from its file name, or the diary; monthly reports aren&apos;t counted. Least on time first. Office only.</p>
        {!punctualRows.length ? <p className="empty">No dated reports yet.</p> : (
          <table><thead><tr><th>Clerk</th><th className="num">Reports</th><th className="num">On time</th><th className="num" title="Working days late, averaged over the late ones">Average late</th><th className="num">Worst</th><th title="The last 30 days against the 3 months">Lately</th><th>Last late report</th></tr></thead>
            <tbody>{punctualRows.map(([k, x]) => {
              const share = x.onTime / x.n, lateN = x.n - x.onTime, recent = x.recentN ? x.recentOn / x.recentN : null;
              return (
                <tr key={k}>
                  <td>{x.id ? <Link href={`/personnel/${x.id}`}>{k}</Link> : k}</td>
                  <td className="num">{x.n}</td>
                  <td className={`num ${share < 0.7 ? "neg" : share >= 0.9 ? "pos" : ""}`}>{Math.round(share * 100)}%</td>
                  <td className="num">{lateN ? `${(x.lateDays / lateN).toFixed(1)} days` : "—"}</td>
                  <td className={`num ${x.worst >= 5 ? "neg" : ""}`}>{x.worst ? `${x.worst} days` : "—"}</td>
                  <td className="small">{recent === null ? <span className="muted">none lately</span> : recent > share + 0.1 ? <span className="pos">↑ better</span> : recent < share - 0.1 ? <span className="neg">↓ worse</span> : <span className="muted">→ steady</span>}</td>
                  <td className="small">{x.lastLate ? <>{x.lastLate.days} day{x.lastLate.days === 1 ? "" : "s"} late, {fd(x.lastLate.up)}<span className="two muted">{x.lastLate.file.slice(0, 60)}</span></> : <span className="muted">none</span>}</td>
                </tr>
              );
            })}</tbody></table>
        )}
      </section>

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

      {!!tr.length && (
        <details className="panel"><summary>From the old turnaround spreadsheet ({monthLabel(monthStart)})</summary>
          <table><thead><tr><th>Clerk</th><th className="num">Reports</th><th className="num">Average days</th><th className="num">Over 2 days</th><th className="num">Review required</th></tr></thead>
            <tbody>{tr.map((x) => <tr key={x.clerk}><td>{x.clerk}</td><td className="num">{x.reports}</td><td className="num">{x.avg_days}</td><td className="num">{x.over_two_days}</td><td className="num">{x.review_required}</td></tr>)}</tbody></table>
        </details>
      )}
    </>
  );
}

function addDays(d: string, n: number) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
