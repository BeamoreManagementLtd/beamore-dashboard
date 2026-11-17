import { fmtDate } from "@/lib/portal/data";

/** A clerk's report scores over time, for themselves (Ronan, 17 Nov 2026: "just do a graph of their scores"). */
export function ScoreGraph({ rows }: { rows: { id: string; when: string; score: number; name: string }[] }) {
  if (rows.length < 2) return null;
  const W = 640, H = 190, L = 30, R = 10, T = 10, B = 24;
  const x = (k: number) => L + (k * (W - L - R)) / (rows.length - 1);
  const y = (s: number) => T + (1 - s / 100) * (H - T - B);
  const line = rows.map((r, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(r.score).toFixed(1)}`).join(" ");
  return (
    <section className="card">
      <h2>Your scores over time</h2>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Your report scores over time, out of 100" style={{ maxWidth: W, display: "block" }}>
        {[0, 2, 4, 6, 8, 10].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g * 10)} y2={y(g * 10)} stroke="var(--line, #e2e2e2)" strokeWidth="1" />
            <text x={L - 6} y={y(g * 10) + 4} fontSize="11" textAnchor="end" fill="var(--muted, #6b6b6b)">{g * 10}</text>
          </g>
        ))}
        <path d={line} fill="none" stroke="var(--link, #3b7d8b)" strokeWidth="2" />
        {rows.map((r, k) => (
          <a key={r.id} href={`/portal/reports/${r.id}`}>
            <circle cx={x(k)} cy={y(r.score)} r="4" fill="var(--surface, #fff)" stroke="var(--link, #3b7d8b)" strokeWidth="2">
              <title>{`${fmtDate(r.when)} · ${r.name}: ${Math.round(r.score)}/100`}</title>
            </circle>
          </a>
        ))}
        <text x={L} y={H - 6} fontSize="11" fill="var(--muted, #6b6b6b)">{fmtDate(rows[0].when)}</text>
        <text x={W - R} y={H - 6} fontSize="11" textAnchor="end" fill="var(--muted, #6b6b6b)">{fmtDate(rows[rows.length - 1].when)}</text>
      </svg>
      <p className="small muted">Each dot is one report, out of 100. Click a dot to see that report&apos;s feedback.</p>
    </section>
  );
}
