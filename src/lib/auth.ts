import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Role = "director" | "admin";
export type Profile = { id: string; email: string; full_name: string | null; role: Role };

/** The signed-in staff member, or a redirect to /login. Role comes from the database, never from the browser. */
export async function requireProfile(): Promise<Profile> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: profile } = await supabase.from("profiles").select("id,email,full_name,role").eq("id", user.id).single();
  if (!profile) redirect("/portal"); // clerks have no dashboard profile: their place is the portal
  return profile as Profile;
}

export async function requireDirector(): Promise<Profile> {
  const p = await requireProfile();
  if (p.role !== "director") redirect("/?denied=1");
  return p;
}
