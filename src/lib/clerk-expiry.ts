import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { PI_ASK_PENCE } from "@/lib/portal/data";
import { queueEmail } from "@/lib/outbox";

/**
 * Renewals (onboarding O2, "for as long as they work with us"), run once a day.
 *
 * Insurance (professional indemnity, public liability) is SENT automatically from Ronan's Gmail (Ronan, 16 Nov 2026:
 * "a week beforehand, on the day if they still haven't sent it, and then weekly after that looking for it"). It stops
 * as soon as a renewed certificate moves the expiry date on (uploading it on the portal does that), or the clerk is
 * made inactive. Each email sent is kept on the "Emails to send" page as a record.
 *
 * CSCS cards and DBS rechecks due within 30 days (or lapsed in the last 60) get one email per date, waiting on the
 * "Emails to send" page for someone to send.
 */
const INSURANCE = [
  ["pi_insurance_expiry", "PI", "professional indemnity insurance"],
  ["pl_insurance_expiry", "PL", "public liability insurance"],
] as const;
const OTHER = [
  ["cscs_expiry", "CSCS card", "expires"],
  ["dbs_recheck", "DBS check", "is due for a recheck"],
] as const;
const DAY = 864e5;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
const SIGN = "Regards\n\nRonan O'Boyle\nBeamore Management Ltd";
const PORTAL = "https://portal.beamore.co.uk\n\nSign in with your @beamore.co.uk Google account and go to Insurance. A PDF or a photo of the certificate is fine.";

/** The reminder that's due today for an expiry date, if any: a week before, on the day, then every 7 days after. */
export function reminderDue(expires: string, today: string, lastSent: string | null) {
  const e = Date.parse(`${expires}T00:00:00Z`), t = Date.parse(`${today}T00:00:00Z`);
  if (t < e - 7 * DAY) return null;
  const stage = t < e ? e - 7 * DAY : t < e + 7 * DAY ? e : e + Math.floor((t - e) / (7 * DAY)) * 7 * DAY;
  if (lastSent && Date.parse(`${lastSent}T00:00:00Z`) >= stage) return null;
  return t < e ? "before" : t < e + DAY ? "today" : "after";
}

export async function runRenewals(admin: SupabaseClient, opts: { dryRun?: boolean } = {}) {
  const today = iso(Date.now());
  const soon = iso(Date.now() + 30 * DAY), back = iso(Date.now() - 60 * DAY);
  const { data: rows } = await admin.from("clerk_compliance")
    .select("clerk_id,pi_insurance_expiry,pl_insurance_expiry,cscs_expiry,dbs_recheck,expiry_chased,clerks(name,email,active)");
  // the latest certificate on file for each clerk and type counts too (an upload in a company name may not have
  // moved the date on their record)
  const { data: pols } = await admin.from("insurance_policies").select("clerk_id,type,cover_pence,expires").in("type", ["PI", "PL"]);
  const latest = new Map<string, { expires: string | null; cover: number | null }>();
  for (const p of pols ?? []) { const k = `${p.clerk_id}:${p.type}`; const c = latest.get(k); if (!c || (p.expires ?? "") > (c.expires ?? "")) latest.set(k, { expires: p.expires, cover: p.cover_pence }); }

  const out = { sent: 0, queued: 0, plan: [] as string[] };
  let g: Awaited<ReturnType<typeof driveClient>> | null = null;
  for (const r of rows ?? []) {
    const c = r.clerks as unknown as { name: string; email: string | null; active: boolean } | null;
    if (!c?.active || !c.email) continue;
    const first = c.name.split(" ")[0];
    const chased = { ...((r.expiry_chased ?? {}) as Record<string, string>) };

    // 1. insurance: sent automatically on the schedule
    const due: { field: string; label: string; expires: string; when: "before" | "today" | "after"; cover: number | null; type: string }[] = [];
    for (const [field, type, label] of INSURANCE) {
      const onFile = latest.get(`${r.clerk_id}:${type}`);
      const expires = [r[field] as string | null, onFile?.expires ?? null].filter(Boolean).sort().pop() ?? null;
      if (!expires) continue;
      const when = reminderDue(expires, today, chased[`${field}@${expires}`] ?? null);
      if (when) due.push({ field, label, expires, when, cover: onFile?.cover ?? null, type });
    }
    if (due.length) {
      const lines = due.map((d) => `- your ${d.label} ${d.when === "before" ? `expires on ${fmt(d.expires)}` : d.when === "today" ? "expires today" : `expired on ${fmt(d.expires)}, and we haven't had the renewed certificate yet`}`);
      const pi = due.find((d) => d.type === "PI");
      const body = `Hi ${first}\n\nJust a reminder that:\n\n${lines.join("\n")}\n\nCould you upload the renewed ${due.length > 1 ? "certificates" : "certificate"} on the portal${due.every((d) => d.when === "before") ? " when you have " + (due.length > 1 ? "them" : "it") : " as soon as you can"}?\n\n${PORTAL}${pi && pi.cover !== null && pi.cover < PI_ASK_PENCE ? `\n\nWhen you renew your professional indemnity, could you increase the cover to £1 million? Your current policy is £${(pi.cover / 100).toLocaleString("en-GB")}, and Beamore asks all clerks for £1 million.` : ""}\n\n${SIGN}`;
      const subject = due.some((d) => d.when !== "before") ? `Your insurance has expired: please upload the renewal` : `Your insurance renewal is due on ${fmt(due[0].expires)}`;
      out.plan.push(`${c.name}: ${due.map((d) => `${d.type} ${d.expires} (${d.when})`).join(", ")}`);
      if (!opts.dryRun) {
        g ??= await driveClient(admin);
    // nothing is sent automatically from Ronan's address (Ronan, 25 Nov 2026): it waits on "Emails to send" for a person to check and send
        for (const d of due) chased[`${d.field}@${d.expires}`] = today;
        await admin.from("clerk_compliance").update({ expiry_chased: chased }).eq("clerk_id", r.clerk_id);
        await queueEmail(admin, { kind: "insurance-renewal", to: c.email, subject, body, clerkId: r.clerk_id, ref: `${r.clerk_id}:${today}`, status: "waiting", note: "Check and send (automatic sending is off)" }).catch(() => undefined);
        out.sent++;
      }
    }

    // 2. CSCS and DBS: one email per date, waiting on the "Emails to send" page
    const other = OTHER.filter(([f]) => { const d = r[f] as string | null; return d && d <= soon && d >= back && chased[f] !== d; });
    if (other.length && !opts.dryRun) {
      const lines = other.map(([f, label, verb]) => { const d = r[f] as string; return `- your ${label} ${d < today ? (verb === "expires" ? "expired" : "was due for a recheck") : verb} on ${fmt(d)}`; });
      const body = `Hi ${first}\n\nOur records show that:\n\n${lines.join("\n")}\n\nCould you send us the renewed ${other.length > 1 ? "documents" : "document"} when you have ${other.length > 1 ? "them" : "it"}? You can upload ${other.length > 1 ? "them" : "it"} on the portal (Certificates), or a photo or PDF by reply is fine.\n\nhttps://portal.beamore.co.uk\n\n${SIGN}`;
      await queueEmail(admin, { kind: "renewal", to: c.email, subject: `Renewal due: ${other.map(([, label]) => label).join(", ")}`, body, clerkId: r.clerk_id, ref: `${r.clerk_id}:${other.map(([f]) => `${f}=${r[f]}`).join(",")}` });
      for (const [f] of other) chased[f] = r[f] as string;
      await admin.from("clerk_compliance").update({ expiry_chased: chased }).eq("clerk_id", r.clerk_id);
      out.queued++;
    }
  }
  return out;
}
