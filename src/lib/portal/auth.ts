import "server-only";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export type PortalClerk = {
  id: string; name: string; email: string; billing: string | null; invoice_upload: boolean; invoices_paused: boolean;
  portal_role: "clerk" | "admin" | "accounts"; documents_folder_id: string | null;
  finance_visible: boolean; // may see their invoice amounts and Xero payment history (not subcontractors via an agency)
};
export type PortalUser = { email: string; staff: { role: "director" | "admin"; name: string | null } | null; clerk: PortalClerk | null; viewingAs?: boolean };

/**
 * The signed-in person for the clerk portal. Clerks have no dashboard profile, so their portal pages read and write
 * with the service role, and every query is pinned to this clerk's own id. Staff (Ronan) can open the portal too.
 */
export async function requirePortalUser(): Promise<PortalUser> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login?next=/portal");
  const email = user.email.toLowerCase();
  const admin = createServiceClient();
  const { data: prof } = await admin.from("profiles").select("role,full_name").eq("id", user.id).maybeSingle();
  // staff can look at the portal exactly as one clerk sees it (read only: uploads are refused while viewing as)
  const as = prof ? (await cookies()).get("portal_as")?.value : undefined;
  const cols = "id,name,email,billing,invoice_upload,invoices_paused,portal_role,portal_access,active,finance_visible,clerk_compliance(documents_folder_id)";
  const { data: c } = as ? await admin.from("clerks").select(cols).eq("id", as).maybeSingle() : await admin.from("clerks").select(cols).ilike("email", email).maybeSingle();
  const staff = prof ? { role: prof.role as "director" | "admin", name: prof.full_name as string | null } : null;
  const ok = c && ((c.portal_access && c.active) || !!as);
  if (!staff && !ok) redirect("/login?error=no-portal");
  const comp = (Array.isArray(c?.clerk_compliance) ? c?.clerk_compliance[0] : c?.clerk_compliance) as { documents_folder_id: string | null } | null | undefined;
  return {
    email, staff, viewingAs: !!as && !!c,
    clerk: ok ? {
      id: c.id, name: c.name, email: c.email ?? email, billing: c.billing, invoice_upload: c.invoice_upload,
      invoices_paused: c.invoices_paused, portal_role: c.portal_role, finance_visible: !!c.finance_visible, documents_folder_id: comp?.documents_folder_id ?? null,
    } : null,
  };
}
