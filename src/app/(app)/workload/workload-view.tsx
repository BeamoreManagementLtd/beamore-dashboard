"use client";
import Link from "next/link";
import { Fragment, useState, useTransition } from "react";
import type { Kind, WClerk, Workload } from "@/lib/workload";
import { rereadCostSchedules, setDaysPerWeek, setMonthDays } from "./actions";

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

export function WorkloadView({ w, lastRead }: { w: Workload; lastRead: string | null }) {
  const [open, setOpen] = useState<Record<Kind, string | null>>({ building: null, me: null });
  const [busy, start] = useTransition();
  const [note, setNote] = useState("");
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
        </div>
      </div>
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
        {projects.map((p) => <span key={p.id}><Sw c={colour.get(p.id)!} b={colour.get(p.id)!} /> {p.name}{p.possible ? " (proposal out)" : ""}</span>)}
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
                  <Sw c={colour.get(p.id)!} b={colour.get(p.id)!} /> <Link href={`/projects/${p.id}`}>{p.name}</Link>
                  {p.possible && <span className="muted"> · proposal</span>}{p.stage === "on_hold" && <span className="muted"> · on hold</span>}
                </td>
                {months.map((m, i) => (
                  <td key={m} onClick={() => edit(p.id, m, p.days[i])} title={`${p.name}, ${mlong(m)}: ${n1(p.days[i])} days${p.witness[i] ? `, of which ${n1(p.witness[i])} witnessing / snagging` : ""}${p.edited[i] ? " (changed by hand)" : ""}. Click to change.`}
                    style={{ textAlign: "center", cursor: "pointer", fontVariantNumeric: "tabular-nums", background: p.witness[i] ? "var(--warn-soft)" : undefined, outline: p.edited[i] ? "1.5px dashed var(--link)" : undefined, outlineOffset: -3 }}>
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
