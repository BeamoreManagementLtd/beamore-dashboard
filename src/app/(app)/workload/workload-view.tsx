"use client";
import Link from "next/link";
import { Fragment, useState, useTransition } from "react";
import type { Agreed, Kind, WClerk, Workload } from "@/lib/workload";
import { addAgreed, removeAgreed, rereadCostSchedules, setDaysPerWeek, setMonthDays } from "./actions";

type Choices = { clerks: { id: string; name: string }[]; jobs: { id: string; name: string }[] };
const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const agreedText = (a: Agreed) => `${n1(a.days)} day${a.days === 1 ? "" : "s"} a ${a.per} from ${fmtDate(a.from)}${a.to ? ` to ${fmtDate(a.to)}` : " until further notice"}`;

/** The Workload page (Ronan, 17 Nov 2026). Server work is in src/lib/workload.ts. */
const COL = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#3b7d8b", "#a4620a"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const mlabel = (m: string, i: number) => `${MON[Number(m.slice(5, 7)) - 1]}${i === 0 || m.slice(5, 7) === "01" ? ` ${m.slice(2, 4)}` : ""}`;
const mlong = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const n1 = (n: number) => (Math.round(n * 10) / 10).toString();
const TITLE: Record<Kind, string> = { building: "Building clerks of works", me: "M&E clerks of works" };
const quiet = (c: WClerk) => {
  if (!c.avail) return null;
  for (let i = 0; i < Math.min(6, c.planned.length); i++) if (c.avail[i] > 0 && c.planned[i] < c.avail[i] * 0.5) return i;
  return null;
};
const over = (c: WClerk) => (c.avail ? c.planned.findIndex((p, i) => p > c.avail![i] + 0.01) : -1);
const tone = (p: number, a: number | null) => (a == null || !p ? "" : p > a + 0.01 ? "bad" : p > a * 0.85 ? "warn" : "good");

export function WorkloadView({ w, lastRead, choices, today }: { w: Workload; lastRead: string | null; choices: Choices; today: string }) {
  const [open, setOpen] = useState<Record<Kind, string | null>>({ building: null, me: null });
  const [busy, start] = useTransition();
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const months = w.months;

  const spare = (kind: Kind, i: number, not: string | null) =>
    w.sections[kind].filter((c) => c.avail && c.id !== not && c.avail[i] - c.planned[i] >= 2)
      .map((c) => ({ name: c.name, d: c.avail![i] - c.planned[i] })).sort((a, b) => b.d - a.d).slice(0, 3);

  const help = (["building", "me"] as Kind[]).flatMap((k) => w.sections[k].map((c) => ({ k, c, i: over(c) })).filter((x) => x.i >= 0)).sort((a, b) => a.i - b.i);
  const quietList = (["building", "me"] as Kind[]).flatMap((k) => w.sections[k].map((c) => ({ k, c, i: quiet(c) })).filter((x): x is { k: Kind; c: WClerk; i: number } => x.i != null)).sort((a, b) => a.i - b.i);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
        <h1 style={{ margin: 0 }}>Workload</h1>
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <span className="small muted">Cost schedules last read {lastRead ? new Date(lastRead).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "never"}</span>
          <button className="btn" type="button" disabled={busy} onClick={() => start(async () => { setNote("Reading every project's cost schedule, this can take a minute or two…"); const r = await rereadCostSchedules(); setNote(r.message); })}>{busy ? "Reading…" : "Re-read cost schedules"}</button>
          <button className="btn primary" type="button" onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add agreed work"}</button>
        </div>
      </div>
      {adding && <AgreedPanel w={w} choices={choices} today={today} onDone={(m) => { setNote(m); }} />}
      <p className="muted" style={{ marginTop: 6 }}>{mlong(months[0])} to {mlong(months[months.length - 1])}. Days per month from the cost schedule of each job, on whoever is allocated to it, against the working days they have (weekdays less bank holidays and their holidays). Allocate a clerk on a project and their row here changes straight away.</p>
      {note && <p className="callout info small">{note}</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 12, margin: "12px 0 6px" }}>
        <div className="callout bad" style={{ color: "var(--ink)" }}>
          <b style={{ color: "var(--bad)" }}>Needs help · {help.length} booked for more days than they have</b>
          {!help.length && <div className="small" style={{ marginTop: 4 }}>Nobody is over.</div>}
          {help.slice(0, 8).map(({ k, c, i }) => {
            const s = spare(k, i, c.id);
            return <div key={`${k}${c.id}`} className="small" style={{ borderTop: "1px solid var(--line)", padding: "5px 0" }}>
              <a href="#" onClick={(e) => { e.preventDefault(); setOpen({ ...open, [k]: c.id }); document.getElementById(`${k}-${c.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}><b>{c.name}</b></a>
              <span className="muted"> · {k === "me" ? "M&E" : "Building"} · from {mlong(months[i])}</span>: {n1(c.planned[i])} days booked, {n1(c.avail![i])} available, <b>{n1(c.planned[i] - c.avail![i])} over</b>
              <div className="muted">{s.length ? `Has room that month: ${s.map((x) => `${x.name} (${n1(x.d)} spare)`).join(", ")}` : "Nobody of the same type has 2 or more spare days that month"}</div>
            </div>;
          })}
          {help.length > 8 && <div className="small muted">and {help.length - 8} more below</div>}
        </div>
        <div className="callout good" style={{ color: "var(--ink)" }}>
          <b style={{ color: "var(--good)" }}>Going quiet · {quietList.length} with under half their days booked in the next 6 months</b>
          {!quietList.length && <div className="small" style={{ marginTop: 4 }}>Everyone is at least half booked.</div>}
          {quietList.slice(0, 10).map(({ k, c, i }) => (
            <div key={`${k}${c.id}`} className="small" style={{ borderTop: "1px solid var(--line)", padding: "5px 0" }}>
              <b>{c.name}</b><span className="muted"> · {k === "me" ? "M&E" : "Building"}</span>: {i === 0 ? "this month" : `from ${mlong(months[i])}`}, {n1(c.planned[i])} of {n1(c.avail![i])} days booked, <b>{n1(c.avail![i] - c.planned[i])} free</b>
              {c.possible[i] > 0 && <span className="muted"> ({n1(c.possible[i])} more if proposals come in)</span>}
            </div>
          ))}
          {quietList.length > 10 && <div className="small muted">and {quietList.length - 10} more below</div>}
        </div>
      </div>

      {w.unplanned.length > 0 && (
        <details className="callout warn" style={{ color: "var(--ink)", margin: "6px 0 10px" }}>
          <summary style={{ cursor: "pointer" }}><b style={{ color: "var(--warn)" }}>No planned visits · {w.unplanned.length} won or live jobs with nothing planned from {mlong(months[0])} on</b>
            <span className="small muted"> · their clerks look quieter here than they are. Click to see them.</span></summary>
          <p className="small muted" style={{ margin: "6px 0" }}>Each needs a month-by-month cost schedule in its Cost Proposals folder (read every morning), or the visits agreed with <b>Add agreed work</b> above. Then what&apos;s been done can be compared with what was planned.</p>
          <table className="small" style={{ marginTop: 4 }}>
            <thead><tr><th style={{ textAlign: "left" }}>Job</th><th style={{ textAlign: "left" }}>Clerk (building / M&amp;E)</th><th style={{ textAlign: "left" }}>Why</th></tr></thead>
            <tbody>
              {w.unplanned.map((u) => (
                <tr key={u.id}>
                  <td><Link href={`/projects/${u.id}`}>{u.name}</Link>{u.stage !== "live" && <span className="muted"> · {u.stage === "on_hold" ? "on hold" : "won"}</span>}</td>
                  <td>{u.clerks || <span className="muted">nobody yet</span>}</td>
                  <td className="muted">{u.why}{u.lastPlanned ? ` (last planned month ${mlong(u.lastPlanned)})` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <div className="row small muted" style={{ gap: 14, flexWrap: "wrap", margin: "10px 0" }}>
        <span><Sw c="var(--bad-soft)" b="var(--bad)" /> Booked for more than they have</span>
        <span><Sw c="var(--warn-soft)" b="var(--warn)" /> Over 85%</span>
        <span><Sw c="var(--good-soft)" b="var(--good)" /> Has room</span>
        <span><i>+3</i> days more on proposals out, if won</span>
        <span>Click a name to see their jobs and change a month</span>
      </div>

      {(["building", "me"] as Kind[]).map((k) => {
        const list = w.sections[k];
        const none = list.find((c) => !c.id);
        return (
          <section key={k} style={{ marginTop: 22 }}>
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <h2 style={{ margin: "0 0 6px" }}>{TITLE[k]}</h2>
              <span className="small muted">{list.filter((c) => c.id).length} clerks{none ? ` · ${n1(none.planned[1] ?? 0)} days next month with no clerk yet` : ""}</span>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ tableLayout: "fixed", minWidth: 190 + months.length * 40, fontSize: 12.5 }}>
                <thead><tr><th style={{ width: 190, textAlign: "left", position: "sticky", left: 0, zIndex: 1, background: "var(--surface)" }}></th>{months.map((m, i) => <th key={m} style={{ textAlign: "center", fontWeight: 500, color: "var(--muted)" }}>{mlabel(m, i)}</th>)}</tr>
                  <tr><td className="muted small" style={{ position: "sticky", left: 0, zIndex: 1, background: "var(--surface)" }}>Working days</td>{w.working.map((d, i) => <td key={i} className="muted small" style={{ textAlign: "center" }}>{d}</td>)}</tr></thead>
                <tbody>
                  {list.map((c) => {
                    const isOpen = open[k] === (c.id ?? "none");
                    return (
                      <Fragment key={c.id ?? "none"}>
                        <tr id={`${k}-${c.id}`}>
                          <td style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", position: "sticky", left: 0, zIndex: 1, background: "var(--surface)" }}>
                            <button type="button" onClick={() => setOpen({ ...open, [k]: isOpen ? null : (c.id ?? "none") })} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", color: c.id ? "var(--ink)" : "var(--muted)", fontStyle: c.id ? "normal" : "italic", font: "inherit", fontWeight: c.id ? 600 : 400 }}>
                              {isOpen ? "▾" : "▸"} {c.name}
                            </button>
                            {c.id && c.daysPerWeek !== 5 && <span className="small muted"> · {n1(c.daysPerWeek)} d/wk</span>}
                          </td>
                          {months.map((m, i) => {
                            const t = tone(c.planned[i], c.avail?.[i] ?? null);
                            return <td key={m} title={`${c.name}, ${mlong(m)}: ${n1(c.planned[i])} days booked${c.avail ? ` of ${n1(c.avail[i])} available` : ""}${c.off[i] ? ` (${n1(c.off[i])} holiday)` : ""}${c.possible[i] ? `; ${n1(c.possible[i])} more on proposals out` : ""}`}
                              style={{ textAlign: "center", fontVariantNumeric: "tabular-nums", background: t ? `var(--${t}-soft)` : undefined, color: t ? `var(--${t})` : undefined, fontWeight: t === "bad" ? 700 : 500 }}>
                              {c.planned[i] ? n1(c.planned[i]) : ""}{c.possible[i] ? <i className="muted" style={{ fontWeight: 400 }}> +{n1(c.possible[i])}</i> : ""}
                            </td>;
                          })}
                        </tr>
                        {isOpen && <tr><td colSpan={months.length + 1} style={{ background: "var(--surface-2)", padding: "12px 10px" }}><Detail c={c} k={k} w={w} /></td></tr>}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Work agreed verbally: who, which job, so many days a week or a month, from when until when. */
function AgreedPanel({ w, choices, today, onDone }: { w: Workload; choices: Choices; today: string; onDone: (m: string) => void }) {
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState("");
  const [f, setF] = useState({ clerkId: "", projectId: "", label: "", kind: "building" as Kind, days: "1", per: "week" as "week" | "month", from: today, to: "", note: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = () => start(async () => {
    const r = await addAgreed({ clerkId: f.clerkId, projectId: f.projectId === "other" ? null : f.projectId || null, label: f.label, kind: f.kind,
      days: Number(f.days), per: f.per, from: f.from, to: f.to || null, note: f.note });
    setMsg(r.message);
    if (r.ok) { onDone(`${r.message}. It's on their row below.`); setF({ ...f, projectId: "", label: "", note: "" }); }
  });
  return (
    <div className="card" style={{ margin: "12px 0", padding: 14 }}>
      <b>Work agreed by phone or in person</b>
      <p className="small muted" style={{ margin: "4px 0 10px" }}>For work with no cost schedule, or where what&apos;s been agreed is different from it. It counts on the clerk&apos;s row from the start date, and for those months it takes the place of the job&apos;s cost schedule. If nobody is allocated to the job yet, the clerk is allocated too.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10, alignItems: "end" }}>
        <label className="small">Clerk<select value={f.clerkId} onChange={set("clerkId")} style={{ width: "100%" }}><option value="">Choose…</option>{choices.clerks.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="small">Job<select value={f.projectId} onChange={set("projectId")} style={{ width: "100%" }}><option value="">Choose…</option>{choices.jobs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value="other">Not a job on the dashboard…</option></select></label>
        {f.projectId === "other" && <label className="small">What is it<input value={f.label} onChange={set("label")} placeholder="e.g. private job, Smith extension" style={{ width: "100%" }} /></label>}
        <label className="small">Building or M&amp;E<select value={f.kind} onChange={set("kind")} style={{ width: "100%" }}><option value="building">Building</option><option value="me">M&amp;E</option></select></label>
        <label className="small">How much<span className="row" style={{ gap: 6 }}><input value={f.days} onChange={set("days")} inputMode="decimal" style={{ width: 60 }} /> days a <select value={f.per} onChange={set("per")}><option value="week">week</option><option value="month">month</option></select></span></label>
        <label className="small">From<input type="date" value={f.from} onChange={set("from")} style={{ width: "100%" }} /></label>
        <label className="small">Until (leave empty for until further notice)<input type="date" value={f.to} onChange={set("to")} style={{ width: "100%" }} /></label>
        <label className="small">Note<input value={f.note} onChange={set("note")} placeholder="e.g. agreed with the client on the phone" style={{ width: "100%" }} /></label>
        <div><button className="btn primary" type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : "Add"}</button> <span className="small muted">{msg}</span></div>
      </div>
      {w.agreed.length > 0 && <>
        <div className="small" style={{ marginTop: 14, fontWeight: 600 }}>Agreed work on the page now</div>
        <table className="small" style={{ marginTop: 4 }}>
          <tbody>
            {w.agreed.map((a) => (
              <tr key={a.id}>
                <td>{a.clerk}</td>
                <td>{a.projectId ? <Link href={`/projects/${a.projectId}`}>{a.job}</Link> : a.job} <span className="muted">· {a.kind === "me" ? "M&E" : "building"}</span></td>
                <td>{agreedText(a)}{a.note ? <span className="muted"> · {a.note}</span> : null}</td>
                <td><button className="btn" type="button" disabled={busy} onClick={() => { if (window.confirm(`Take off ${a.clerk}'s ${a.job} (${agreedText(a)})?`)) start(async () => { const r = await removeAgreed(a.id); setMsg(r.message); }); }}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </>}
    </div>
  );
}

function Sw({ c, b }: { c: string; b: string }) {
  return <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: c, border: `1px solid ${b}`, verticalAlign: -1 }} />;
}

function Detail({ c, k, w }: { c: WClerk; k: Kind; w: Workload }) {
  const months = w.months;
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState("");
  const [dpw, setDpw] = useState(String(c.daysPerWeek));
  const projects = c.projects;
  const colour = new Map(projects.map((p, i) => [p.id, COL[i % COL.length]]));

  // chart: stacked bars by project (proposals out paler), days available (dashed), already in the diary (dots)
  const W = Math.max(760, 30 + months.length * 36), H = 210, L = 30, B = 22, bw = (W - L) / months.length;
  const tot = months.map((_, i) => c.planned[i] + c.possible[i]);
  const max = Math.max(5, ...tot, ...(c.avail ?? []), ...c.diary) * 1.12;
  const y = (v: number) => H - B - (v / max) * (H - B - 8);
  const step = max > 40 ? 10 : 5;
  const edit = (pid: string, m: string, cur: number) => {
    const v = window.prompt(`Days in ${mlong(m)} (leave empty to go back to the cost schedule)`, n1(cur));
    if (v === null) return;
    const days = v.trim() === "" ? null : Number(v);
    if (days != null && !(days >= 0)) { setMsg("Enter a number of days"); return; }
    start(async () => { const r = await setMonthDays(pid, m, k, days); setMsg(r.ok ? (days == null ? "Back to the cost schedule" : "Saved") : r.message); });
  };

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {c.id ? (
        <div className="row small" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Link href={`/personnel/${c.id}`}>Personnel page</Link>
          <span className="muted">·</span>
          <label className="row" style={{ gap: 6, alignItems: "center" }}>Works for us
            <input value={dpw} onChange={(e) => setDpw(e.target.value)} style={{ width: 50 }} inputMode="decimal" /> days a week</label>
          <button className="btn" type="button" disabled={busy || Number(dpw) === c.daysPerWeek} onClick={() => start(async () => { const r = await setDaysPerWeek(c.id!, Number(dpw)); setMsg(r.message); })}>Save</button>
          {c.off.some((d) => d > 0) && <span className="muted">Holidays: {c.off.map((d, i) => (d ? `${n1(d)} in ${mlabel(months[i], 1)}` : "")).filter(Boolean).join(", ")}</span>}
        </div>
      ) : <div className="small muted">Days in cost schedules on jobs with nobody allocated yet. Allocate a clerk on the project page and the days move to them.</div>}

      <div className="row small muted" style={{ gap: 12, flexWrap: "wrap" }}>
        {projects.map((p) => <span key={p.id}><Sw c={colour.get(p.id)!} b={colour.get(p.id)!} /> {p.name}{p.possible ? " (proposal out)" : ""}{p.agreed ? " (agreed)" : ""}</span>)}
        {c.avail && <span><svg width="18" height="8"><line x1="0" x2="18" y1="4" y2="4" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="4 3" /></svg> Days available</span>}
        {c.diary.some((d) => d > 0) && <span><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--brand)" /></svg> Already in the diary</span>}
      </div>
      <div><svg viewBox={`0 0 ${W} ${H}`} width={W} style={{ maxWidth: "none" }} role="img" aria-label={`${c.name}: days booked per month by project`}>
        {Array.from({ length: Math.floor(max / step) + 1 }, (_, t) => t * step).map((t) => (
          <g key={t}><line x1={L} x2={W} y1={y(t)} y2={y(t)} stroke="var(--line)" /><text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{t}</text></g>
        ))}
        {months.map((m, i) => {
          let acc = 0;
          return <g key={m}>
            {projects.map((p) => {
              const d = p.days[i];
              if (!d) return null;
              const y0 = y(acc), y1 = y(acc + d); acc += d;
              return <rect key={p.id} x={L + i * bw + bw * 0.2} y={y1 + 1} width={bw * 0.6} height={Math.max(0, y0 - y1 - 1)} rx="2" fill={colour.get(p.id)} opacity={p.possible ? 0.4 : 1}>
                <title>{`${p.name}: ${n1(d)} days in ${mlong(m)}${p.witness[i] ? ` (${n1(p.witness[i])} witnessing / snagging)` : ""}${p.possible ? ", proposal out" : ""}`}</title></rect>;
            })}
            <text x={L + i * bw + bw / 2} y={H - 6} textAnchor="middle" fontSize="11" fill="var(--muted)">{mlabel(m, i)}</text>
          </g>;
        })}
        {c.avail && <path d={c.avail.map((v, i) => `${i ? "L" : "M"}${L + i * bw + 3},${y(v)}L${L + (i + 1) * bw - 3},${y(v)}`).join("")} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeDasharray="4 3" />}
        {c.diary.map((v, i) => v > 0 && <circle key={i} cx={L + i * bw + bw / 2} cy={y(v)} r="4.5" fill="var(--brand)" stroke="var(--surface-2)" strokeWidth="2"><title>{`Already in the diary for ${mlong(months[i])}: ${n1(v)} days`}</title></circle>)}
      </svg></div>

      <div>
        <table style={{ tableLayout: "fixed", minWidth: 190 + months.length * 40, fontSize: 12 }}>
          <tbody>
            {projects.map((p) => (
              <tr key={p.id}>
                <td style={{ width: 190, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", position: "sticky", left: 0, zIndex: 1, background: "var(--surface-2)" }} title={p.name}>
                  <Sw c={colour.get(p.id)!} b={colour.get(p.id)!} /> {p.agreed ? (p.projectId ? <Link href={`/projects/${p.projectId}`}>{p.name}</Link> : p.name) : <Link href={`/projects/${p.id}`}>{p.name}</Link>}
                  {p.agreed && <span className="muted"> · agreed</span>}
                  {p.possible && <span className="muted"> · proposal</span>}{p.stage === "on_hold" && <span className="muted"> · on hold</span>}
                </td>
                {months.map((m, i) => (
                  <td key={m} onClick={() => (p.agreed ? setMsg("That's agreed work: change it under Add agreed work at the top") : edit(p.id, m, p.days[i]))}
                    title={`${p.name}, ${mlong(m)}: ${n1(p.days[i])} days${p.witness[i] ? `, of which ${n1(p.witness[i])} witnessing / snagging` : ""}${p.edited[i] ? " (changed by hand)" : ""}${p.agreed ? " (agreed work)" : ". Click to change."}`}
                    style={{ textAlign: "center", cursor: "pointer", fontVariantNumeric: "tabular-nums", background: p.witness[i] ? "var(--warn-soft)" : p.agreed && p.days[i] ? "var(--info-soft, var(--surface))" : undefined, outline: p.edited[i] ? "1.5px dashed var(--link)" : undefined, outlineOffset: -3 }}>
                    {p.days[i] ? n1(p.days[i]) : <span className="muted">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small muted">Click a month to change it if a job has slipped (a dashed box shows a changed month; the cost schedule won&apos;t overwrite it). Shaded months include witnessing / snagging days.{busy ? " Saving…" : msg ? ` ${msg}` : ""}</div>
    </div>
  );
}
