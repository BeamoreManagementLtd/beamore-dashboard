import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type StaffPerson = { email: string; first: string; name: string; role: string; profileId: string | null };

/** Everyone with dashboard access (staff_emails), whether or not they've signed in yet. Needs a service-role client. */
export async function staffPeople(admin: SupabaseClient): Promise<StaffPerson[]> {
  const [{ data: staff }, { data: profiles }, { data: clerks }] = await Promise.all([
    admin.from("staff_emails").select("email,role,note"),
    admin.from("profiles").select("id,email,full_name"),
    admin.from("clerks").select("name,email").not("email", "is", null),
  ]);
  return (staff ?? []).map((s) => {
    const p = (profiles ?? []).find((x) => x.email?.toLowerCase() === s.email);
    const c = (clerks ?? []).find((x) => x.email?.toLowerCase() === s.email);
    const fromNote = /(?:Admin|Owner):?\s*([A-Z][\w'-]+(?: [A-Z][\w'-]+)*)/.exec(s.note ?? "")?.[1];
    const local = s.email.split("@")[0].split(".").map((w: string) => w[0].toUpperCase() + w.slice(1)).join(" ");
    const name = p?.full_name ?? c?.name ?? (fromNote && fromNote !== "Owner" ? fromNote : local);
    return { email: s.email, first: name.split(" ")[0], name, role: s.role, profileId: p?.id ?? null };
  }).sort((a, b) => (a.role === "director" ? -1 : b.role === "director" ? 1 : a.name.localeCompare(b.name)));
}
