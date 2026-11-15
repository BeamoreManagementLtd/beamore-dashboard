import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, today } from "@/lib/format";
import { saveHoliday, dismissHolidayEmail } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The Diary screen (Ronan, 15 Nov 2026: move the team off Diary 2026.xlsx onto the dashboard). A week at a time:
 * each clerk's planned visits (the diary's grey side), what they charged (the salmon side) and their holidays, with
 * the things worth a look picked out: planned visits not charged yet, visits booked on a holiday, charges with nothing
 * planned. Read from the diary sync, so it's as up to date as the diary.
 */
type Visit = { visit_date: string; clerk_id: string | null; project_id: string | null; site_as_typed: string; kind: string; side: "planned" | "charged"; days: number; clerks: { name: string } | null; projects: { id: string; display_name: string } | null };
type Absence = { clerk_id: string; date_from: string; date_to: string; part_day: string | null; kind: string; status: string };

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const mondayOf = (d: string) => { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return addDays(d, -((w + 6) % 7)); };
const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Dates, half day, kind and who arranges cover: shared by the email and by-hand forms. */
function HolidayFields({ from, to, part, kind, staff, cover }: { from: string | null; to: string | null; part: string | null; kind: string; staff: { id: string; full_name: string | null; email: string }[]; cover: string }) {
  return (
    <>
      <div className="field"><label>First day</label><input type="date" name="date_from" required defaultValue={from ?? ""} /></div>
      <div className="field"><label>Last day</label><input type="date" name="date_to" defaultValue={to ?? from ?? ""} /></div>
      <div className="field"><label>Half day?</label><select name="part_day" defaultValue={part ?? ""}><option value="">Full days</option><option value="am">Morning only</option><option value="pm">Afternoon only</option></select></div>
      <div className="field"><label>Type</label><select name="kind" defaultValue={kind}><option>Holiday</option><option>Sick</option><option>Day off</option></select></div>
      <div className="field"><label>Cover arranged by</label><select name="cover_for" defaultValue={cover}>{staff.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>)}</select></div>
    </>
  );
}

const halves = (n: number) => (n === 0.5 ? "½" : n % 1 ? `${Math.floor(n)}½` : String(n));

export default async function Diary({ searchParams }: { searchParams: Promise<{ week?: string; clerk?: string; all?: string; done?: string; error?: string }> }) {
  await requireProfile();
  const sp = await searchParams;
  const t = today();
  const monday = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(sp.week ?? "") ? sp.week! : t);
  const sunday = addDays(monday, 6);
  const db = await createClient();
  const [{ data: visitRows }, { data: absRows }, { data: clerkRows }] = await Promise.all([
    db.from("diary_visits").select("visit_date,clerk_id,project_id,site_as_typed,kind,side,days,clerks(name),projects(id,display_name)").gte("visit_date", monday).lte("visit_date", sunday).limit(5000),
    db.from("absences").select("clerk_id,date_from,date_to,part_day,kind,status").lte("date_from", sunday).gte("date_to", monday).neq("status", "cancelled"),
    db.from("clerks").select("id,name,active").order("name"),
  ]);
  // charges go in when a clerk's invoice for the month arrives, so a planned day only counts as "not charged" once
  // that clerk has charged something else that month
  const { data: chargedRows } = await db.from("diary_visits").select("clerk_id,visit_date").eq("side", "charged")
    .gte("visit_date", `${monday.slice(0, 7)}-01`).lte("visit_date", addDays(`${sunday.slice(0, 7)}-01`, 31)).limit(10000);
  const invoicedMonth = new Set((chargedRows ?? []).map((r) => `${r.clerk_id}|${String(r.visit_date).slice(0, 7)}`));
  // holidays: emails from clerks waiting to be added, and upcoming holidays with how they're getting on
  const [{ data: requests }, { data: upcoming }, { data: staff }] = await Promise.all([
    db.from("holiday_requests").select("id,clerk_id,received_at,from_email,subject,excerpt,date_from,date_to,part_day,kind,ai_note,clerks(name)").eq("status", "pending").order("received_at"),
    db.from("absences").select("id,clerk_id,date_from,date_to,part_day,kind,status,source,diary_state,diary_note,synced_to_diary_at,cover_task_id,clerks(name),tasks:cover_task_id(title,done_at)").gte("date_to", t).neq("status", "cancelled").order("date_from").limit(40),
    db.from("profiles").select("id,full_name,email,role").order("full_name"),
  ]);
  const director = (staff ?? []).find((p) => p.role === "director")?.id ?? "";
  const visits = (visitRows ?? []) as unknown as Visit[];
  const absences = (absRows ?? []) as Absence[];
  const clerks = clerkRows ?? [];

  // which days to show: Mon-Fri, plus Saturday/Sunday if anyone worked them
  const days = Array.from({ length: 7 }, (_, k) => addDays(monday, k)).filter((d, k) => k < 5 || visits.some((v) => v.visit_date === d));

  // per clerk, per day: planned and charged sites (half-day slots added up), and any absence
  type Cell = { planned: Map<string, { days: number; pid: string | null }>; charged: Map<string, { days: number; pid: string | null }>; away: Absence | null };
  const grid = new Map<string, Map<string, Cell>>();
  const cellOf = (clerk: string, d: string) => {
    const row = grid.get(clerk) ?? new Map<string, Cell>();
    grid.set(clerk, row);
    const c = row.get(d) ?? { planned: new Map(), charged: new Map(), away: null };
    row.set(d, c);
    return c;
  };
  for (const v of visits) {
    if (!v.clerk_id) continue;
    const name = v.projects?.display_name ?? v.site_as_typed;
    const side = cellOf(v.clerk_id, v.visit_date)[v.side];
    const s = side.get(name) ?? { days: 0, pid: v.projects?.id ?? null };
    s.days += Number(v.days);
    side.set(name, s);
  }
  for (const a of absences) for (const d of days) if (d >= a.date_from && d <= a.date_to) cellOf(a.clerk_id, d).away = a;

  // things worth a look this week
  const flags: { clerk: string; date: string; text: string; tone: "warn" | "bad" | "neutral" }[] = [];
  const clerkName = new Map(clerks.map((c) => [c.id, c.name]));
  for (const [cid, row] of grid) for (const [d, c] of row) {
    const who = clerkName.get(cid) ?? "?";
    if (c.away && (c.planned.size || c.charged.size)) flags.push({ clerk: who, date: d, tone: "bad", text: `${c.away.kind.toLowerCase()} booked, but ${[...c.planned.keys(), ...c.charged.keys()].join(", ")} is in the diary too` });
    if (d < t && c.planned.size && !c.charged.size && !c.away && invoicedMonth.has(`${cid}|${d.slice(0, 7)}`)) flags.push({ clerk: who, date: d, tone: "warn", text: `planned ${[...c.planned.keys()].join(", ")}, but this day isn't on their invoice for the month` });
    for (const [site] of c.charged) if (c.planned.size && !c.planned.has(site)) flags.push({ clerk: who, date: d, tone: "neutral", text: `charged ${site}, which wasn't the planned visit (${[...c.planned.keys()].join(", ")})` });
  }
  flags.sort((a, b) => (a.tone === "bad" ? 0 : a.tone === "warn" ? 1 : 2) - (b.tone === "bad" ? 0 : b.tone === "warn" ? 1 : 2) || a.date.localeCompare(b.date));

  // rows: clerks with anything this week (or every active clerk when asked), optionally just one
  const shown = clerks.filter((c) => (sp.clerk ? c.id === sp.clerk : sp.all ? c.active || grid.has(c.id) : grid.has(c.id)));
  const total = (cid: string, side: "planned" | "charged") => [...(grid.get(cid)?.values() ?? [])].reduce((n, c) => n + [...c[side].values()].reduce((m, s) => m + s.days, 0), 0);
  const q = (o: Record<string, string | undefined>) => { const p = new URLSearchParams(Object.entries({ week: monday, clerk: sp.clerk, all: sp.all, ...o }).filter(([, v]) => v) as [string, string][]); return `/diary?${p}`; };

  return (
    <>
      <div className="head">
        <div>
          <h1>Diary</h1>
          <p>Week of {fd(monday)} · planned visits <span className="dv-key dv-planned">grey</span>, charged <span className="dv-key dv-charged">salmon</span>, holidays <span className="dv-key dv-away">blue</span>. From Diary {monday.slice(0, 4)}, updated by the diary sync.</p>
        </div>
        <div className="btn-row">
          <Link className="btn" href={q({ week: addDays(monday, -7) })}>← Previous week</Link>
          <Link className="btn" href={q({ week: mondayOf(t) })}>This week</Link>
          <Link className="btn" href={q({ week: addDays(monday, 7) })}>Next week →</Link>
        </div>
      </div>

      {sp.done && <p className="callout">{sp.done}</p>}
      {sp.error && <p className="callout neg">{sp.error}</p>}

      {(requests ?? []).length > 0 && (
        <section className="panel">
          <h2>Holiday emails to add <span className="small muted">{requests!.length}</span></h2>
          <p className="small muted">Clerks&apos; emails about time off, with the dates the AI read from them. Check the dates, then add: it goes into the diary and a to-do is made to arrange cover.</p>
          {requests!.map((r) => {
            const who = (r.clerks as unknown as { name?: string } | null)?.name ?? r.from_email;
            return (
              <div key={r.id} className="dv-req">
                <p><b>{who}</b> · {fd(r.received_at)} · &ldquo;{r.subject}&rdquo;{r.ai_note ? <> · <span className="muted">{r.ai_note}</span></> : null}</p>
                <details className="small"><summary>Read the email</summary><p style={{ whiteSpace: "pre-wrap" }}>{r.excerpt}</p></details>
                {r.clerk_id ? (
                  <form action={saveHoliday} className="btn-row">
                    <input type="hidden" name="clerk_id" value={r.clerk_id} /><input type="hidden" name="request_id" value={r.id} /><input type="hidden" name="week" value={monday} />
                    <HolidayFields from={r.date_from} to={r.date_to} part={r.part_day} kind={r.kind} staff={staff ?? []} cover={director} />
                    <button className="btn">Add to diary and make cover to-do</button>
                  </form>
                ) : <p className="small neg">This email address isn&apos;t on a clerk&apos;s record, so add it below by hand.</p>}
                <form action={dismissHolidayEmail.bind(null, r.id)}><button className="linklike small">Not a holiday / already done</button></form>
              </div>
            );
          })}
        </section>
      )}

      {flags.length > 0 && (
        <section className="panel">
          <h2>Worth a look this week <span className="small muted">{flags.length}</span></h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {flags.slice(0, 40).map((f, k) => (
              <li key={k}><span className={`pill ${f.tone}`}>{f.tone === "bad" ? "Clash" : f.tone === "warn" ? "Not charged" : "Different site"}</span> {fd(f.date)} · <b>{f.clerk}</b>: {f.text}</li>
            ))}
          </ul>
          {flags.length > 40 && <p className="small muted">…and {flags.length - 40} more.</p>}
        </section>
      )}

      <section className="panel">
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <form action="/diary" className="btn-row">
            <input type="hidden" name="week" value={monday} />
            <select name="clerk" defaultValue={sp.clerk ?? ""} aria-label="Clerk">
              <option value="">Everyone with visits this week</option>
              {clerks.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn">Show</button>
          </form>
          {!sp.clerk && <Link className="small" href={q({ all: sp.all ? undefined : "1" })}>{sp.all ? "Only clerks with visits" : "Show every active clerk"}</Link>}
        </div>
        {!shown.length ? <p className="empty">Nothing in the diary for this week{sp.clerk ? " for this clerk" : ""}.</p> : (
          <div className="tbl-wrap">
            <table className="dv">
              <thead>
                <tr><th>Clerk</th>{days.map((d) => <th key={d} className={d === t ? "dv-today" : ""}>{WEEKDAY[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]} {fd(d)}</th>)}<th className="num" title="Days planned / days charged this week">Planned / charged</th></tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/personnel/${c.id}`}>{c.name}</Link></td>
                    {days.map((d) => {
                      const cell = grid.get(c.id)?.get(d);
                      const late = d < t && cell?.planned.size && !cell.charged.size && !cell.away && invoicedMonth.has(`${c.id}|${d.slice(0, 7)}`);
                      return (
                        <td key={d} className={`${d === t ? "dv-today" : ""} ${late ? "dv-late" : ""}`}>
                          {cell?.away && <div className="dv-chip dv-away">{cell.away.kind}{cell.away.part_day ? ` (${cell.away.part_day})` : ""}{cell.away.status === "provisional" ? "?" : ""}</div>}
                          {[...(cell?.planned ?? [])].map(([site, s]) => (
                            <div key={`p${site}`} className="dv-chip dv-planned" title={`Planned: ${site}, ${halves(s.days)} day`}>{s.pid ? <Link href={`/projects/${s.pid}`}>{site}</Link> : <i>{site}</i>} <span className="muted">{halves(s.days)}</span></div>
                          ))}
                          {[...(cell?.charged ?? [])].map(([site, s]) => (
                            <div key={`c${site}`} className="dv-chip dv-charged" title={`Charged: ${site}, ${halves(s.days)} day`}>{s.pid ? <Link href={`/projects/${s.pid}`}>{site}</Link> : <i>{site}</i>} <span className="muted">{halves(s.days)}</span></div>
                          ))}
                        </td>
                      );
                    })}
                    <td className="num">{halves(total(c.id, "planned"))} / {halves(total(c.id, "charged"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">Sites in <i>italics</i> aren&apos;t matched to a project yet. Each filled diary slot is half a day.</p>
      </section>

      <div className="grid2">
        <section className="panel">
          <h2>Add a holiday</h2>
          <p className="small muted">Goes into the diary (&ldquo;Holiday&rdquo; in that clerk&apos;s Comments for each weekday, from November 2026) and makes a to-do to arrange cover, listing the sites they&apos;re down for or usually cover on those days.</p>
          <form action={saveHoliday} className="form">
            <input type="hidden" name="week" value={monday} />
            <div className="field"><label htmlFor="hclerk">Clerk</label>
              <select id="hclerk" name="clerk_id" required defaultValue={sp.clerk ?? ""}><option value="">Choose…</option>{clerks.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </div>
            <HolidayFields from={null} to={null} part={null} kind="Holiday" staff={staff ?? []} cover={director} />
            <label className="small"><input type="checkbox" name="provisional" /> Not confirmed yet</label>
            <div><button className="btn">Add holiday</button></div>
          </form>
        </section>
        <section className="panel">
          <h2>Coming up</h2>
          {!(upcoming ?? []).length ? <p className="empty">No holidays booked.</p> : (
            <table><tbody>{(upcoming ?? []).map((a) => {
              const task = a.tasks as unknown as { title: string; done_at: string | null } | null;
              const inDiary = a.synced_to_diary_at || a.source === "diary" ? "In the diary" : a.diary_state === "written" ? "Written to the diary" : a.diary_state === "waiting" ? "Going into the diary" : a.diary_state === "needs_review" ? "Needs adding by hand" : "Not in the diary";
              return (
                <tr key={a.id}>
                  <td><Link href={`/diary?week=${a.date_from}&clerk=${a.clerk_id}`}>{(a.clerks as unknown as { name?: string } | null)?.name}</Link><br /><span className="small muted">{fd(a.date_from)}{a.date_to !== a.date_from ? ` – ${fd(a.date_to)}` : ""}{a.part_day ? ` (${a.part_day})` : ""} · {a.kind}{a.status === "provisional" ? " (not confirmed)" : ""}</span></td>
                  <td className="small"><span className={`pill ${/hand|Not in/.test(inDiary) ? "warn" : "good"}`} title={a.diary_note ?? ""}>{inDiary}</span><br />{task ? <span className={task.done_at ? "pos" : "muted"}>{task.done_at ? "Cover arranged" : "Cover to-do open"}</span> : <span className="muted">No cover to-do</span>}</td>
                </tr>
              );
            })}</tbody></table>
          )}
        </section>
      </div>
    </>
  );
}
