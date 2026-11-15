import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export const PI_MIN_PENCE = 50_000_000; // £500,000 professional indemnity, required (Ronan, 15 Nov 2026)
export const PL_MIN_PENCE = 100_000_000; // £1m public liability, if they have it

export const QUAL_TYPES = ["CSCS card", "MCIOB", "MICWCI", "MCABE", "SMSTS / SSSTS", "First aid", "Degree / HNC / HND", "CV", "Other"];

export type Upload = {
  id: string; receipt: string; kind: string; doc_type: string | null; file_name: string | null; received_at: string; status: string;
  issues: string[]; ai_result: Record<string, unknown> | null; period: string | null; drive_file_id: string | null; source: string;
};
export type Policy = {
  id: string; type: string; description: string | null; insurer: string | null; insured_name: string | null;
  cover_pence: number | null; starts: string | null; expires: string | null; upload_id: string | null; source: string;
};

const today = () => new Date().toISOString().slice(0, 10);

export async function myUploads(db: SupabaseClient, clerkId: string, kind?: string[]) {
  let q = db.from("portal_uploads").select("id,receipt,kind,doc_type,file_name,received_at,status,issues,ai_result,period,drive_file_id,source")
    .eq("clerk_id", clerkId).neq("status", "deleted").neq("status", "uploading").order("received_at", { ascending: false });
  if (kind) q = q.in("kind", kind);
  const { data } = await q;
  // the old portal stored files as <receipt>.pdf: show a plain label instead of the code
  return ((data ?? []) as Upload[]).map((u) => (/^[0-9a-f-]{36}.pdf$/i.test(u.file_name ?? "") ? { ...u, file_name: null } : u));
}

export async function myPolicies(db: SupabaseClient, clerkId: string) {
  const { data } = await db.from("insurance_policies").select("id,type,description,insurer,insured_name,cover_pence,starts,expires,upload_id,source")
    .eq("clerk_id", clerkId).order("expires", { ascending: false, nullsFirst: false });
  return (data ?? []) as Policy[];
}

/** The newest policy of each type, and whether the £500,000 PI requirement is met today. */
export function insuranceSummary(policies: Policy[]) {
  const t = today();
  const latest = new Map<string, Policy>();
  for (const p of policies) {
    const cur = latest.get(p.type);
    if (!cur || (p.expires ?? "") > (cur.expires ?? "")) latest.set(p.type, p);
  }
  const pi = latest.get("PI") ?? null;
  const piOk = !!pi && !!pi.expires && pi.expires >= t && (pi.cover_pence ?? 0) >= PI_MIN_PENCE;
  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  return {
    latest, pi, piOk,
    piText: !pi ? "No professional indemnity certificate on file"
      : !pi.expires ? "Professional indemnity on file, expiry date not read yet"
      : pi.expires < t ? `Professional indemnity expired on ${fmtDate(pi.expires)}`
      : (pi.cover_pence ?? 0) < PI_MIN_PENCE ? `Professional indemnity cover is ${gbp(pi.cover_pence)} (we need at least £500,000)`
      : `Professional indemnity in date until ${fmtDate(pi.expires)}${pi.expires <= soon ? " (renewal due soon)" : ""}`,
  };
}

export function gbp(pence: number | null | undefined) {
  if (pence === null || pence === undefined) return "—";
  const v = pence / 100;
  return v >= 1_000_000 ? `£${(v / 1_000_000).toLocaleString("en-GB", { maximumFractionDigits: 2 })}m` : `£${v.toLocaleString("en-GB", { maximumFractionDigits: 2 })}`;
}
export function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  return new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** What the clerk sees for an upload: plain words, never internal pipeline jargon. */
export function clerkStatus(u: Upload): { text: string; tone: "good" | "warn" | "bad" | "neutral" } {
  if (u.status === "needs_correction") return { text: "Please upload a clearer or complete copy", tone: "bad" };
  if (u.status === "accepted") return { text: u.kind === "invoice" ? "Checked" : "Checked and recorded", tone: "good" };
  if (u.status === "paid") return { text: "Paid", tone: "good" };
  return { text: "Received", tone: "neutral" };
}
