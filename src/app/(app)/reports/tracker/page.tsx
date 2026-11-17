import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { today } from "@/lib/format";
import { loadHolidays } from "@/lib/reports/days";
import { buildTracker, type Cell } from "@/lib/reports/tracker";
import { setReporting, setChasing } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STYLE: Record<Cell["state"], { bg: string; fg: string; text: string; title: string }> = {
  sent: { bg: "var(--good-soft)", fg: "var(--good)", text: "✓", title: "In and sent" },
  in: { bg: "var(--warn-soft)", fg: "var(--warn)", text: "in", title: "In, not checked or sent yet" },
  missing: { bg: "var(--bad-soft)", fg: "var(--bad)", text: "!", title: "Missing" },
  due: { bg: "var(--surface)", fg: "var(--muted)", text: "due", title: "Due: not late yet" },
  none: { bg: "var(--surface-2)", fg: "var(--muted)", text: "", title: "No report due" },
  hol: { bg: "var(--surface-2)", fg: "var(--muted)", text: "hol", title: "Clerk on holiday" },
  hold: { bg: "var(--surface-2)", fg: "var(--muted)", text: "–", title: "Job on hold" },
};
const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * The report tracker (Ronan, 17 Nov 2026), replacing Anél's "Diary TRACKER" spreadsheet: every live job by week, which
 * reports are in, which are sent, and which are missing (two working days after the visit), worked out from the files
 * in the job's report folders, the diary and the job's reporting frequency.
 */
export default async function ReportTracker({ searchParams }: { searchParams: Promise<{ who?: string; show?: string }> }) {
  const me = await requireProfile();
  const { who, show } = await searchParams;
  const db = await createClient();
  const t = today();
  const h = await loadHolidays();
  const { data: settings } = await db.from("report_settings").select("clerk_days,chase_missing").eq("id", 1).single();
  const tr = await buildTracker(db, t, h, 8, settings?.clerk_days ?? 2);
  const thisWeek = tr.cols.at(-1)!;
  const lastWeek = tr.cols.at(-2)!;
  const { data: chases } = await db.from("email_outbox").select("ref,created_at").eq("kind", "report-missing");
  const chased = new Map((chases ?? []).map((c) => [c.ref as string, c.created_at as string]));
  const clerks = [...new Set(tr.rows.map((r) => r.clerk).filter(Boolean))].sort() as string[];
  let rows = who ? tr.rows.filter((r) => r.clerk === who) : tr.rows;
  if (show === "problems") rows = rows.filter((r) => r.cells.some((c) => c.state === "missing" || c.state === "in"));
  const count = (s: Cell["state"], w: string) => tr.rows.filter((r) => r.cells[tr.cols.indexOf(w)]?.state === s).length;
  const missing = who ? tr.missing.filter((m) => m.r.clerk === who) : tr.missing;
  const href = (o: { who?: string | null; show?: string | null }) => {
    const q = new URLSearchParams();
    const w = o.who === undefined ? who : o.who, s = o.show === undefined ? show : o.show;
    if (w) q.set("who", w); if (s) q.set("show", s);
    return `/reports/tracker${q.size ? `?${q}` : ""}`;
  };

  return (
    <>
      <div className="head">
        <div>
          <h1>Report tracker</h1>
          <p>Every live job, week by week: which reports are in, which are sent and which are missing. A report is missing two working days after the visit in the diary (or, with no diary days, each week for a weekly job). Worked out automatically, every 15 minutes.</p>
        </div>
        <div className="row"><Link className="btn" href="/reports">← Reports to check</Link></div>
      </div>

      <div className="tiles">
        <div className="tile"><span className="label">Last week ({short(lastWeek)}): due</span><span className="big">{tr.rows.filter((r) => !["none", "hol", "hold"].includes(r.cells.at(-2)!.state)).length}</span></div>
        <div className="tile"><span className="label">Last week: in and sent</span><span className="big" style={{ color: "var(--good)" }}>{count("sent", lastWeek)}</span></div>
        <div className="tile"><span className="label">Last week: in, not sent</span><span className="big" style={{ color: "var(--warn)" }}>{count("in", lastWeek)}</span></div>
        <div className={`tile ${tr.missing.length ? "alert" : ""}`}><span className="label">Missing now (8 weeks)</span><span className="big" style={{ color: "var(--bad)" }}>{tr.missing.length}</span><span className="sub">{count("due", thisWeek)} more due this week</span></div>
      </div>

      <section className="panel">
        <h2>Missing now</h2>
        {!missing.length ? <p className="empty">Nothing missing.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Job</th><th>Clerk</th><th>Week of</th><th>Due</th><th className="num">Working days late</th><th>Chased</th></tr></thead>
            <tbody>{missing.map(({ r, c, week }) => {
              const at = chased.get(`${r.key}:${week}`);
              return (
                <tr key={`${r.key}:${week}`}>
                  <td><Link href={`/projects/${r.projectId}`}>{r.name}</Link>{r.kind === "monthly" ? "" : <span className="muted small"> · {r.frequency ?? "frequency not set"}</span>}</td>
                  <td>{r.clerk ?? <span className="muted">no clerk</span>}</td>
                  <td>{short(week)}</td><td>{c.dueOn ? short(c.dueOn) : ""}</td>
                  <td className="num"><span className={`pill ${(c.overdue ?? 0) >= 5 ? "bad" : "warn"}`}>{c.overdue}</span></td>
                  <td className="small">{at ? `Emailed ${short(at.slice(0, 10))}` : <span className="muted">{settings?.chase_missing ? "Not yet" : "Chasing off"}</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
        <p className="small muted">
          Chasing by email is {settings?.chase_missing ? <b>on</b> : <b>off</b>}: {settings?.chase_missing ? "the clerk gets one friendly email from Ronan's Gmail when a report goes missing." : "nothing is sent to clerks about missing reports yet."}{" "}
          {me.role === "director" && <form action={setChasing} style={{ display: "inline" }}><input type="hidden" name="on" value={settings?.chase_missing ? "0" : "1"} /><button className="btn small">{settings?.chase_missing ? "Switch chasing off" : "Switch chasing on"}</button></form>}
        </p>
      </section>

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <h2 style={{ margin: 0 }}>Week by week</h2>
          <div className="small">
            <Link className={`btn small ${show !== "problems" ? "primary" : ""}`} href={href({ show: null })}>All jobs</Link>{" "}
            <Link className={`btn small ${show === "problems" ? "primary" : ""}`} href={href({ show: "problems" })}>Only missing or not sent</Link>{" "}
            <select defaultValue={who ?? ""} style={{ marginLeft: 6 }} aria-label="Clerk" name="who" form="who-form">
              <option value="">Every clerk</option>{clerks.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <form id="who-form" action="/reports/tracker" style={{ display: "inline" }}>{show && <input type="hidden" name="show" value={show} />}<button className="btn small">Show</button></form>
          </div>
        </div>
        <div className="tbl-wrap">
          <table style={{ borderCollapse: "separate", borderSpacing: 3 }}>
            <thead><tr><th>Job</th><th>Clerk</th>{tr.cols.map((w) => <th key={w} style={{ textAlign: "center", fontWeight: 400 }} className="small">{short(w)}</th>)}</tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.key}>
                <td className="small" style={{ whiteSpace: "nowrap" }}><Link href={`/projects/${r.projectId}`}>{r.name}</Link>{r.elsewhere ? <span className="muted"> · in {r.elsewhere}</span> : null}</td>
                <td className="small muted" style={{ whiteSpace: "nowrap" }}>{r.clerk ?? ""}</td>
                {r.cells.map((c, k) => {
                  const s = STYLE[c.state];
                  const title = `${s.title}${c.label ? ` (${c.label})` : ""}${c.files.length ? `: ${c.files.map((f) => f.name).join(", ")}` : c.dueOn ? `, due ${short(c.dueOn)}` : ""}`;
                  const box = <span style={{ display: "block", minWidth: 38, height: 22, lineHeight: "22px", borderRadius: 5, textAlign: "center", fontSize: 11.5, fontWeight: c.state === "missing" ? 700 : 500, background: s.bg, color: s.fg, border: c.state === "due" ? "1px dashed var(--line)" : "none" }}>{c.label === "Monthly" && c.files.length ? "M" : s.text}</span>;
                  return <td key={k} title={title} style={{ padding: 0 }}>{c.files[0] ? <a href={`https://drive.google.com/file/d/${c.files[0].id}/view`} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>{box}</a> : box}</td>;
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p className="small muted">✓ in and sent · <span style={{ color: "var(--warn)" }}>in</span> = in, not checked or sent yet · <span style={{ color: "var(--bad)" }}>!</span> missing · due = not late yet · grey = no report due (no visit that week, clerk on holiday, or job on hold) · M = monthly report. Click a box to open the report.</p>
      </section>

      {tr.noFrequency.length > 0 && (
        <section className="panel">
          <h2>How often do these jobs report?</h2>
          <p className="small muted">These live jobs have no reporting frequency, so they&apos;re only tracked in weeks the diary has a visit. Setting it here also fills it in on the job.</p>
          <div className="tbl-wrap"><table><tbody>{tr.noFrequency.map((p) => (
            <tr key={p.id}><td><Link href={`/projects/${p.id}`}>{p.name}</Link></td><td>
              <form action={setReporting} className="row" style={{ gap: 6 }}>
                <input type="hidden" name="project" value={p.id} />
                <select name="value" defaultValue="Weekly"><option>Weekly</option><option>Fortnightly</option><option>Monthly</option><option value="elsewhere">Reports in FieldView</option></select>
                <button className="btn small">Save</button>
              </form>
            </td></tr>
          ))}</tbody></table></div>
        </section>
      )}
    </>
  );
}
