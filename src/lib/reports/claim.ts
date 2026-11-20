/**
 * "I'm checking this" (Ronan, 20 Nov 2026): someone other than the allocated checker (Andy K, Ronan) picks a report up,
 * so the others can see to leave it. The allocated checker doesn't change. A claim lasts 2 hours, so a forgotten one
 * doesn't block a report all day; sending, marking done or "Stop checking" clears it.
 */
export const CLAIM_HOURS = 2;
const OPEN = ["new", "checking", "ready", "failed"];

/** The live claim on a report, if any: who and since when. */
export function liveClaim(r: { claimed_by?: string | null; claimed_at?: string | null; status?: string }, now = Date.now()) {
  if (!r.claimed_by || !r.claimed_at || (r.status && !OPEN.includes(r.status))) return null;
  if (now - Date.parse(r.claimed_at) > CLAIM_HOURS * 3600_000) return null;
  return { by: r.claimed_by, at: r.claimed_at };
}

export const claimTime = (at: string) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
