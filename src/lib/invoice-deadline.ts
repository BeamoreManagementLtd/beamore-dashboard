import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendFromAi } from "@/lib/outbox";

/**
 * Clerks' monthly invoice deadline (Ronan, 26 Nov 2026): "ask me each month when the invoice date should be, then send
 * them an email 1 week before that date saying we want your invoices by X date. Then 1 day before, a reminder to
 * anybody who hasn't sent in an invoice. Then if somebody hasn't uploaded an invoice to the portal by that time, email
 * them: you're now late with your invoice, to avoid being paid late, please upload it straight away." Sent from
 * ai@beamore.co.uk. Nothing is sent until Ronan sets the date (portal_audit "invoice-deadline", the latest per month).
 */
export type Deadline = { month: string; dueAt: string; setAt: string };
type Stage = "notice" | "reminder" | "late";
const DAY = 864e5;
const PORTAL = "https://portal.beamore.co.uk\n\nSign in with your @beamore.co.uk Google account and go to Invoices. A PDF or a photo of your invoice is fine.";
const SIGN = "Thanks\n\nBeamore AI Assistant\nBeamore Management Ltd";

export const monthName = (m: string) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const whenText = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Europe/London" }).replace(":00", "").replace(" ", "");
  const date = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/London" });
  return { time, date };
};

/** A London date and time ("2026-12-04", "17:00") as a moment in time, whatever the clocks are doing. */
export function londonInstant(date: string, time: string) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const shown = new Date(guess).toLocaleString("en-GB", { timeZone: "Europe/London", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const [dd, mm, rest] = shown.split("/"); const [yyyy, hm] = rest.split(", ");
  const offset = Date.parse(`${yyyy}-${mm}-${dd}T${hm}:00Z`) - guess;
  return new Date(guess - offset).toISOString();
}

/** The deadline Ronan set for each month (the latest one he set wins). */
export async function deadlines(admin: SupabaseClient): Promise<Deadline[]> {
  const { data } = await admin.from("portal_audit").select("at,detail").eq("action", "invoice-deadline").order("at", { ascending: true });
  const by = new Map<string, Deadline>();
  for (const r of data ?? []) { const d = r.detail as { month: string; due_at: string }; by.set(d.month, { month: d.month, dueAt: d.due_at, setAt: r.at }); }
  return [...by.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** The month whose invoices still need a deadline: this month, once it's the 15th (London), if none is set yet. */
export async function monthNeedingDeadline(admin: SupabaseClient, today: string) {
  if (Number(today.slice(8, 10)) < 15) return null;
  const m = today.slice(0, 7);
  return (await deadlines(admin)).some((d) => d.month === m) ? null : m;
}

/** Clerks who should invoice for a month: active, invoicing through the portal, and in the diary that month. */
async function clerksFor(admin: SupabaseClient, month: string) {
  const next = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)).toISOString().slice(0, 10);
  // a month has thousands of diary rows: read them all, a page at a time (one read stops at 1,000)
  const found = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data: page } = await admin.from("diary_visits").select("clerk_id").gte("visit_date", `${month}-01`).lt("visit_date", next).not("clerk_id", "is", null).order("id").range(from, from + 999);
    for (const v of page ?? []) found.add(v.clerk_id as string);
    if ((page ?? []).length < 1000) break;
  }
  const ids = [...found];
  if (!ids.length) return [];
  const { data: clerks } = await admin.from("clerks").select("id,name,email,active,invoice_upload,invoices_paused").in("id", ids);
  const { data: ups } = await admin.from("portal_uploads").select("clerk_id").eq("kind", "invoice").eq("period", month).is("deleted_at", null).neq("status", "deleted");
  const sent = new Set((ups ?? []).map((u) => u.clerk_id as string));
  return (clerks ?? [])
    .filter((c) => c.active && c.email && c.invoice_upload !== false && !c.invoices_paused)
    .map((c) => ({ id: c.id as string, first: (c.name as string).split(" ")[0], email: c.email as string, sent: sent.has(c.id as string) }));
}

function email(stage: Stage, first: string, month: string, dueAt: string) {
  const m = monthName(month), { time, date } = whenText(dueAt);
  if (stage === "notice") return {
    subject: `Your ${m} invoice: due by ${time} on ${date}`,
    body: `Hi ${first}\n\nPlease upload your invoice for ${m} on the portal by ${time} on ${date}.\n\n${PORTAL}\n\n${SIGN}`,
  };
  if (stage === "reminder") return {
    subject: `Reminder: your ${m} invoice is due by ${time} tomorrow`,
    body: `Hi ${first}\n\nJust a reminder that your invoice for ${m} is due by ${time} tomorrow (${date}). We haven't received it yet, so please upload it on the portal before then.\n\n${PORTAL}\n\n${SIGN}`,
  };
  return {
    subject: `Your ${m} invoice is now late`,
    body: `Hi ${first}\n\nYour invoice for ${m} was due by ${time} on ${date} and we haven't received it yet, so it's now late. To avoid being paid late, please upload your invoice on the portal straight away.\n\n${PORTAL}\n\n${SIGN}`,
  };
}

/** Run every 15 minutes: sends whichever of the three emails is due for each deadline, once per clerk. */
export async function runInvoiceDeadlines(admin: SupabaseClient, opts: { dryRun?: boolean; now?: number; deadlines?: Deadline[] } = {}) {
  const now = opts.now ?? Date.now();
  const out = { sent: 0, plan: [] as string[] };
  const { data: done } = await admin.from("portal_audit").select("detail").eq("action", "invoice-deadline-email").gte("at", new Date(now - 90 * DAY).toISOString());
  const sentKeys = new Set((done ?? []).map((d) => (d.detail as { key: string }).key));
  for (const d of opts.deadlines ?? await deadlines(admin)) {
    const due = Date.parse(d.dueAt);
    if (now > due + 14 * DAY) continue; // old months: leave alone
    // the stage due now (only the latest one: a deadline set late doesn't send all three at once)
    const stage: Stage | null = now >= due ? "late" : now >= due - DAY ? "reminder" : now >= due - 7 * DAY || Date.parse(d.setAt) > due - 7 * DAY ? "notice" : null;
    if (!stage) continue;
    for (const c of await clerksFor(admin, d.month)) {
      if (c.sent) continue; // already uploaded this month's invoice
      const key = `${c.id}:${d.month}:${d.dueAt}:${stage}`;
      if (sentKeys.has(key)) continue;
      const e = email(stage, c.first, d.month, d.dueAt);
      out.plan.push(`${stage} -> ${c.email}`);
      if (opts.dryRun) continue;
      await sendFromAi(admin, { kind: `invoice-${stage}`, to: c.email, subject: e.subject, body: e.body, clerkId: c.id, ref: key }).catch(() => undefined);
      await admin.from("portal_audit").insert({ actor: "dashboard", action: "invoice-deadline-email", detail: { key, stage, month: d.month, clerk: c.id } });
      sentKeys.add(key);
      out.sent++;
    }
  }
  return out;
}
