/**
 * How a clerk's report scores are going (Ronan, 15 Nov 2026: "if his scores start at 5s, you want to see them rise
 * up to 6s and 7s and 8s and 9s... If somebody's reports are getting worse, then we need to address that").
 * Scores are kept out of 100; shown out of 10. The trend compares the last five reports with the five before.
 */
export const outOf10 = (score: number) => Math.round(score) / 10;

export function scoreTrend(scores: number[]) {
  if (scores.length < 4) return { dir: "new" as const, recent: null as number | null, before: null as number | null };
  const n = Math.min(5, Math.floor(scores.length / 2));
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const recent = avg(scores.slice(-n)), before = avg(scores.slice(-2 * n, -n));
  // half a mark out of 10 either way counts as a real change
  const dir = recent - before >= 5 ? "up" as const : before - recent >= 5 ? "down" as const : "steady" as const;
  return { dir, recent, before };
}

export const TREND_LABEL = { up: "getting better", down: "getting worse", steady: "steady", new: "not enough reports yet" } as const;
