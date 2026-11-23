/**
 * "On hold: waiting for the clerk" (Ronan, 23 Nov 2026): Andy K sends a report back to the clerk for changes, and nobody
 * else must send it in the meantime. While hold_at is set, Approve and send and Make a clean PDF are refused. The clerk
 * changing their Word file afterwards is pointed out; someone takes it off hold by hand (which checks it again).
 */
export type Hold = { by: string | null; at: string; reason: string | null; updated: boolean };

export function holdOf(r: { hold_at?: string | null; hold_by?: string | null; hold_reason?: string | null; modified_at?: string | null }): Hold | null {
  if (!r.hold_at) return null;
  // the clerk saved the report again at least 5 minutes after it went on hold
  const updated = !!r.modified_at && Date.parse(r.modified_at) > Date.parse(r.hold_at) + 5 * 60_000;
  return { by: r.hold_by ?? null, at: r.hold_at, reason: r.hold_reason ?? null, updated };
}
