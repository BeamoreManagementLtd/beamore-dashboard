"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const STAGES = ["enquiry", "pricing", "sent", "won_arranging", "won_preparing", "live", "on_hold", "lost", "complete"];
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim() || null;

export async function saveProject(id: string, form: FormData) {
  await requireProfile();
  const db = await createClient();
  const stage = s(form, "stage");
  const days = (k: string) => { const v = s(form, k); return v == null ? null : Number(v); };
  await db.from("projects").update({
    ...(stage && STAGES.includes(stage) ? { stage } : {}),
    next_action: s(form, "next_action"), next_action_due: s(form, "next_action_due"), owner_id: s(form, "owner_id"),
    agreed_days_building: days("agreed_days_building"), agreed_days_me: days("agreed_days_me"),
    updated_at: new Date().toISOString(),
  }).eq("id", id);
  revalidatePath(`/projects/${id}`);
  revalidatePath("/projects");
}

/** Adds a diary spelling (or Xero reference) to a project; the next diary/Xero sync then counts it. */
export async function addAlias(id: string, form: FormData) {
  await requireProfile();
  const alias = s(form, "alias");
  if (!alias) return;
  const db = await createClient();
  const { data: p } = await db.from("projects").select("diary_aliases").eq("id", id).single();
  if (p && !p.diary_aliases.includes(alias)) await db.from("projects").update({ diary_aliases: [...p.diary_aliases, alias] }).eq("id", id);
  // an unmatched diary site with this exact name is now resolved
  await db.from("unmatched_diary_sites").update({ resolved_project_id: id }).eq("site_as_typed", alias);
  revalidatePath(`/projects/${id}`);
  revalidatePath("/projects");
}

/** A one-off diary entry that isn't a project (e.g. a site measure): stop listing it as unlinked. */
export async function ignoreSite(site: string) {
  await requireProfile();
  const db = await createClient();
  await db.from("unmatched_diary_sites").update({ ignored: true }).eq("site_as_typed", site);
  revalidatePath("/projects");
  revalidatePath("/due");
}

/** From the Projects page: link an unmatched diary site name to a project. */
export async function linkSite(form: FormData) {
  const project = s(form, "project_id"), site = s(form, "site");
  if (!project || !site) return;
  const f = new FormData();
  f.set("alias", site);
  await addAlias(project, f);
}
