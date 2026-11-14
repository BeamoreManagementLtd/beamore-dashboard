export const gbp = (n: number | null | undefined) =>
  n == null ? "—" : (n < 0 ? "−" : "") + "£" + Math.abs(Math.round(n)).toLocaleString("en-GB");

export const fd = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" }) : "—";

export const fdy = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" }) : "—";

export const fdt = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" }) : "—";

export const today =() => new Date().toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string) =>
  Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);

export const CHASE_STATUS: Record<string, [string, string]> = {
  new: ["bad", "Not chased yet"],
  our_move: ["bad", "We owe a reply"],
  queried: ["warn", "Queried"],
  promised: ["good", "Promised / being processed"],
  waiting: ["neutral", "Waiting on them"],
};
