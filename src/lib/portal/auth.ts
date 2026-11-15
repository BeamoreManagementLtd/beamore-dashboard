import "server-only";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export type PortalClerk = {
  id: string; name: string; email: string; billing: string | null; invoice_upload: boolean; invoices_paused: boolean;
  portal_role: "clerk" | "admin" | "accounts"; documents_folder_id: string | null;
};
export type PortalUser = { email: string; staff: { role: "director" | "admin"; name: string | null } | null; clerk: PortalClerk | null };

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
  const [{ data: prof }, { data: c }] = await Promise.all([
    admin.from("profiles").select("role,full_name").eq("id", user.id).maybeSingle(),
    admin.from("clerks").select("id,name,email,billing,invoice_upload,invoices_paused,portal_role,portal_access,active,clerk_compliance(documents_folder_id)")
      .ilike("email", email).maybeSingle(),
  ]);
  const staff = prof ? { role: prof.role as "director" | "admin", name: prof.full_name as string | null } : null;
  const ok = c && c.portal_access && c.active;
  if (!staff && !ok) redirect("/login?error=no-portal");
  const comp = (Array.isArray(c?.clerk_compliance) ? c?.clerk_compliance[0] : c?.clerk_compliance) as { documents_folder_id: string | null } | null | undefined;
  return {
    email, staff,
    clerk: ok ? {
      id: c.id, name: c.name, email: c.email ?? email, billing: c.billing, invoice_upload: c.invoice_upload,
      invoices_paused: c.invoices_paused, portal_role: c.portal_role, documents_folder_id: comp?.documents_folder_id ?? null,
    } : null,
  };
}
