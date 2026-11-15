import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";

/**
 * Renewal requests (onboarding O2, "for as long as they work with us"): when an active clerk's insurance, CSCS card or
 * DBS recheck is due within 30 days (or lapsed in the last 60), save ONE Gmail draft to them listing what's due.
 * Each expiry date is drafted once (clerk_compliance.expiry_chased). Drafts only: Ronan presses Send.
 */
const FIELDS = [
  ["pi_insurance_expiry", "professional indemnity insurance certificate", "expires"],
  ["pl_insurance_expiry", "public liability insurance certificate", "expires"],
  ["cscs_expiry", "CSCS card", "expires"],
  ["dbs_recheck", "DBS check", "is due for a recheck"],
] as const;

export async function draftExpiryChasers(admin: SupabaseClient) {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const back = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const { data: rows } = await admin.from("clerk_compliance")
    .select("clerk_id,pi_insurance_expiry,pl_insurance_expiry,cscs_expiry,dbs_recheck,expiry_chased,clerks(name,email,active)");
  let drafted = 0;
  let g: Awaited<ReturnType<typeof driveClient>> | null = null;
  const fmt = (d: string) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  for (const r of rows ?? []) {
    const c = r.clerks as unknown as { name: string; email: string | null; active: boolean } | null;
    if (!c?.active || !c.email) continue;
    const chased = (r.expiry_chased ?? {}) as Record<string, string>;
    const due = FIELDS.filter(([f]) => { const d = r[f] as string | null; return d && d <= soon && d >= back && chased[f] !== d; });
    if (!due.length) continue;
    const lines = due.map(([f, label, verb]) => { const d = r[f] as string; return `- your ${label} ${d < today ? (verb === "expires" ? "expired" : "was due for a recheck") : verb} on ${fmt(d)}`; });
    const body = `Hi ${c.name.split(" ")[0]},\n\nOur records show that:\n\n${lines.join("\n")}\n\nCould you send us the renewed ${due.length > 1 ? "documents" : "document"} when you have ${due.length > 1 ? "them" : "it"}? A photo or PDF by reply is fine.\n\nMany thanks,\nRonan\n\nRonan O'Boyle\nBeamore Management Ltd`;
    const raw = [`To: ${c.email}`, `Subject: Renewal due: ${due.map(([, label]) => label.replace(/ certificate$/, "")).join(", ")}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8"].join("\r\n") + "\r\n\r\n" + body.replace(/\n/g, "\r\n");
    g ??= await driveClient(admin);
    await g.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw: Buffer.from(raw).toString("base64url") } });
    const next = { ...chased };
    for (const [f] of due) next[f] = r[f] as string;
    await admin.from("clerk_compliance").update({ expiry_chased: next }).eq("clerk_id", r.clerk_id);
    drafted++;
  }
  return drafted;
}
