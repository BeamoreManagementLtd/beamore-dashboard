/**
 * How a clerk's report scores are going (Ronan, 15 Nov 2026: "if his scores start at 5s, you want to see them rise
 * up to 6s and 7s and 8s and 9s... If somebody's reports are getting worse, then we need to address that").
 * Scores are out of 100 (Ronan, 16 Nov 2026: show them out of 100 only). The trend compares the last five reports with the five before.
 */
export const roundScore = (score: number) => Math.round(score);

export function scoreTrend(scores: number[]) {
  if (scores.length < 4) return { dir: "new" as const, recent: null as number | null, before: null as number | null };
  const n = Math.min(5, Math.floor(scores.length / 2));
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const recent = avg(scores.slice(-n)), before = avg(scores.slice(-2 * n, -n));
  // five marks out of 100 either way counts as a real change
  const dir = recent - before >= 5 ? "up" as const : before - recent >= 5 ? "down" as const : "steady" as const;
  return { dir, recent, before };
}

export const TREND_LABEL = { up: "getting better", down: "getting worse", steady: "steady", new: "not enough reports yet" } as const;
