import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fd } from "@/lib/format";
import { outOf10, scoreTrend, TREND_LABEL } from "@/lib/reports/trend";
import { STANDARDS, STANDARD_KEYS, standardsShare, type StandardKey, type StandardsMet } from "@/lib/reports/standards";

/**
 * A clerk's report scores over time, on their page in the office dashboard only (Ronan, 15 Nov 2026: "keep that within
 * their area of the dashboard that we can have a look at, maybe not for them to look at... Maybe even graph it").
 * The clerk portal never shows this.
 */
export async function ScoreTrend({ clerkId }: { clerkId: string }) {
  const db = await createClient();
  const { data } = await db.from("reports").select("id,file_name,visit_date,checked_at,score,fixes,spelling_fixed")
    .eq("clerk_id", clerkId).not("score", "is", null).order("visit_date", { ascending: true, nullsFirst: false }).limit(200);
  const rows = (data ?? []).map((r) => ({ ...r, when: (r.visit_date ?? r.checked_at?.slice(0, 10) ?? "") as string }))
    .sort((a, b) => a.when.localeCompare(b.when));
  if (!rows.length) return (
    <section className="panel"><h2>Report scores</h2><p className="empty">No checked reports yet. Scores appear here as the dashboard checks their reports.</p></section>
  );

  const scores = rows.map((r) => Number(r.score));
  const t = scoreTrend(scores);
  // rolling average of the last five, so one off report doesn't swing the line
  const rolling = scores.map((_, k) => { const w = scores.slice(Math.max(0, k - 4), k + 1); return w.reduce((s, x) => s + x, 0) / w.length; });
  const W = 640, H = 200, L = 30, R = 10, T = 10, B = 24;
  const x = (k: number) => L + (rows.length === 1 ? (W - L - R) / 2 : (k * (W - L - R)) / (rows.length - 1));
  const y = (s: number) => T + (1 - s / 100) * (H - T - B);
  const line = rolling.map((s, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(s).toFixed(1)}`).join(" ");
  const colour = t.dir === "down" ? "var(--bad)" : t.dir === "up" ? "var(--good)" : "var(--neutral)";

  // best practices over the last ten reports: which they hit, which they miss most
  const last = rows.slice(-10).map((r) => (r.fixes as { standards?: StandardsMet } | null)?.standards).filter(Boolean) as StandardsMet[];
  const hits = last.map(standardsShare).filter((v): v is number => v !== null);
  const missed = STANDARD_KEYS.map((s) => [s, last.filter((m) => m[s] === false).length] as [StandardKey, number]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);

  return (
    <section className="panel">
      <h2>Report scores <span className="small muted">office only: clerks don&apos;t see this</span></h2>
      <p>
        Latest <b>{outOf10(scores[scores.length - 1])}/10</b> · average of the last {Math.min(5, scores.length)} <b>{outOf10(scores.slice(-5).reduce((s, v) => s + v, 0) / Math.min(5, scores.length))}/10</b>
        {" · "}<span className={t.dir === "down" ? "neg" : t.dir === "up" ? "pos" : "muted"}>{TREND_LABEL[t.dir]}{t.recent !== null && t.before !== null && t.dir !== "steady" ? ` (${outOf10(t.before)} → ${outOf10(t.recent)})` : ""}</span>
      </p>
      {t.dir === "down" && <p className="neg small">Their reports are slipping. Worth a friendly word or a look at the latest feedback emails.</p>}
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Report scores over time, ${TREND_LABEL[t.dir]}`} style={{ maxWidth: W, display: "block" }}>
        {[0, 2, 4, 6, 8, 10].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g * 10)} y2={y(g * 10)} stroke="var(--line)" strokeWidth="1" />
            <text x={L - 6} y={y(g * 10) + 4} fontSize="11" textAnchor="end" fill="var(--muted)">{g}</text>
          </g>
        ))}
        {rows.map((r, k) => (
          <circle key={r.id} cx={x(k)} cy={y(scores[k])} r="3.5" fill="var(--surface)" stroke="var(--muted)" strokeWidth="1.5">
            <title>{`${r.when ? fd(r.when) : ""} ${r.file_name}: ${outOf10(scores[k])}/10`}</title>
          </circle>
        ))}
        <path d={line} fill="none" stroke={colour} strokeWidth="2.5" />
        <text x={L} y={H - 6} fontSize="11" fill="var(--muted)">{rows[0].when ? fd(rows[0].when) : ""}</text>
        <text x={W - R} y={H - 6} fontSize="11" textAnchor="end" fill="var(--muted)">{rows[rows.length - 1].when ? fd(rows[rows.length - 1].when) : ""}</text>
      </svg>
      <p className="small muted">Dots: each report&apos;s score out of 10 (hover for the report). Line: average of the last five.</p>
      {hits.length > 0 && (
        <p className="small">
          Best practices: hitting about <b>{Math.round((hits.reduce((s, v) => s + v, 0) / hits.length) * STANDARD_KEYS.length)} of {STANDARD_KEYS.length}</b> in their recent reports.
          {missed.length ? ` Most often missing: ${missed.slice(0, 3).map(([s, n]) => `${STANDARDS[s].label.toLowerCase()} (${n} of ${last.length})`).join(", ")}.` : " Hitting them all."}
        </p>
      )}
      {/* spelling: how many mistakes per report, and the ones that keep coming back (Ronan, 16 Nov 2026) */}
      {(() => {
        const sp = rows.map((r) => Number(r.spelling_fixed ?? 0));
        const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
        const recent = sp.slice(-5), before = sp.slice(-10, -5);
        const words = new Map<string, number>();
        for (const r of rows.slice(-15)) for (const s of ((r.fixes as { spelling?: { find: string; replace: string }[] } | null)?.spelling ?? [])) {
          const k = `${s.find} → ${s.replace}`; words.set(k, (words.get(k) ?? 0) + 1);
        }
        const repeats = [...words].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 8);
        return (
          <p className="small">
            Spelling: <b>{avg(recent).toFixed(1)}</b> mistakes per report in the last {recent.length}
            {before.length ? <> (was {avg(before).toFixed(1)} before{avg(recent) < avg(before) - 0.5 ? <span className="pos">, improving</span> : avg(recent) > avg(before) + 0.5 ? <span className="neg">, getting worse</span> : null})</> : null}
            ; last report {sp[sp.length - 1]}.
            {repeats.length ? <> Keeps making: {repeats.map(([k, n]) => `${k} (${n}×)`).join(", ")}.</> : null}
          </p>
        );
      })()}
      <p className="small"><Link href={`/reports/${rows[rows.length - 1].id}`}>Latest checked report →</Link></p>
    </section>
  );
}
