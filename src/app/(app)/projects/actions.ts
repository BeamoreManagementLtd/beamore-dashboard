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

// ---- project information from the client, and the project log
async function logEvent(projectId: string, kind: string, body: string | null, source = "dashboard") {
  const me = await requireProfile();
  const db = await createClient();
  await db.from("project_events").insert({ project_id: projectId, kind, body, source, who: me.full_name ?? me.email, created_by: me.id });
}

/** Adds the standard list (DfE or other) of things we need from the client; anything already there is kept. */
export async function startInfoChecklist(projectId: string, kind: "dfe" | "standard") {
  await requireProfile();
  const { INFO_DFE, INFO_STANDARD } = await import("@/lib/project-info");
  const db = await createClient();
  const { data: have } = await db.from("project_info").select("item").eq("project_id", projectId);
  const items = (kind === "dfe" ? INFO_DFE : INFO_STANDARD).filter((i) => !(have ?? []).some((h) => h.item === i));
  if (items.length) await db.from("project_info").insert(items.map((item) => ({ project_id: projectId, item })));
  revalidatePath(`/projects/${projectId}`);
}

/** Corrects the automatic DfE decision; the automation won't change it back. */
export async function setDfe(projectId: string, dfe: boolean) {
  const me = await requireProfile();
  const db = await createClient();
  await db.from("projects").update({ is_dfe: dfe, dfe_evidence: `Set by ${me.full_name ?? me.email}` }).eq("id", projectId);
  revalidatePath(`/projects/${projectId}`);
}

export async function addInfoItem(projectId: string, form: FormData) {
  await requireProfile();
  const item = s(form, "item");
  if (!item) return;
  const db = await createClient();
  await db.from("project_info").insert({ project_id: projectId, item });
  revalidatePath(`/projects/${projectId}`);
}

/** Marks everything not yet asked for as requested today, and logs it. */
export async function requestOutstanding(projectId: string) {
  await requireProfile();
  const db = await createClient();
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await db.from("project_info").select("id,item").eq("project_id", projectId).is("requested_on", null).is("received_on", null);
  if (!data?.length) return;
  await db.from("project_info").update({ requested_on: today }).in("id", data.map((d) => d.id));
  await logEvent(projectId, "Info requested", data.map((d) => d.item).join(", "));
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/due");
}

export async function setInfoReceived(projectId: string, itemId: string, received: boolean) {
  await requireProfile();
  const db = await createClient();
  const { data: it } = await db.from("project_info").update({ received_on: received ? new Date().toISOString().slice(0, 10) : null }).eq("id", itemId).select("item").single();
  if (received && it) await logEvent(projectId, "Info received", it.item);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/due");
}

export async function removeInfoItem(projectId: string, itemId: string) {
  await requireProfile();
  const db = await createClient();
  await db.from("project_info").delete().eq("id", itemId);
  revalidatePath(`/projects/${projectId}`);
}

export async function addProjectEvent(projectId: string, form: FormData) {
  const kind = s(form, "kind"), body = s(form, "body");
  if (!body || !kind || !["Phone call", "Email sent", "Email received", "Note"].includes(kind)) return;
  await logEvent(projectId, kind, body, "team");
  revalidatePath(`/projects/${projectId}`);
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
