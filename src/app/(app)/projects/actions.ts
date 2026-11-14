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
  revalidatePath("/projects/dfe");
  revalidatePath("/due");
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

// ---- project workflow (src/lib/workflow.ts)
const workflowLog = async (projectId: string, kind: string, body: string) => {
  const me = await requireProfile();
  const db = await createClient();
  await db.from("project_events").insert({ project_id: projectId, source: "team", kind, who: me.full_name ?? me.email, body, created_by: me.id });
  return { me, db };
};

export async function markStep(projectId: string, step: string, done: boolean) {
  const me = await requireProfile();
  const db = await createClient();
  if (done) await db.from("project_steps").upsert({ project_id: projectId, step, done_by: me.full_name ?? me.email, done_at: new Date().toISOString() });
  else await db.from("project_steps").delete().eq("project_id", projectId).eq("step", step);
  // ticking "cost proposal sent" by hand moves the project on, the same as finding it in sent email
  if (step === "P3" && done) await db.from("projects").update({ stage: "sent" }).eq("id", projectId).in("stage", ["enquiry", "pricing"]);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/workflows");
}

/** P5: won starts set-up (the intake job then starts the checklist); lost closes the project with a reason. */
export async function setOutcome(projectId: string, form: FormData) {
  const outcome = String(form.get("outcome"));
  const reason = String(form.get("reason") ?? "").trim() || null;
  const { db } = await workflowLog(projectId, outcome === "won" ? "Won" : "Lost", outcome === "won" ? "Project won" : `Lost${reason ? `: ${reason}` : ""}`);
  await db.from("projects").update(outcome === "won" ? { stage: "won_arranging" } : { stage: "lost", lost_reason: reason }).eq("id", projectId);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}

/** S3: pick the clerk, or say we need to find one. */
export async function setClerk(projectId: string, form: FormData) {
  const v = String(form.get("clerk") ?? "");
  const db = await createClient();
  if (v === "finding") {
    await workflowLog(projectId, "Clerk of works", "No clerk yet, finding one");
    await db.from("projects").update({ clerk_status: "finding", clerk_id: null }).eq("id", projectId);
  } else if (v) {
    const { data: c } = await db.from("clerks").select("name").eq("id", v).maybeSingle();
    await workflowLog(projectId, "Clerk of works", `${c?.name ?? "Clerk"} allocated`);
    await db.from("projects").update({ clerk_status: "have", clerk_id: v }).eq("id", projectId);
  }
  revalidatePath(`/projects/${projectId}`);
}

export async function setPo(projectId: string, form: FormData) {
  const po = String(form.get("po") ?? "").trim();
  if (!po) return;
  const { db } = await workflowLog(projectId, "PO number", po);
  await db.from("projects").update({ po_number: po }).eq("id", projectId);
  revalidatePath(`/projects/${projectId}`);
}

/** X2: finished (completes once paid), paused (on hold) or still going (asked again next quiet month). */
export async function closeOutAnswer(projectId: string, answer: "finished" | "paused" | "going") {
  const { me, db } = await workflowLog(projectId, "Close-out", answer === "finished" ? "Project finished" : answer === "paused" ? "Project paused" : "Still going");
  await db.from("project_steps").upsert({ project_id: projectId, step: "X2", note: answer, done_by: me.full_name ?? me.email, done_at: new Date().toISOString() });
  if (answer === "paused") await db.from("projects").update({ stage: "on_hold" }).eq("id", projectId);
  if (answer === "finished") {
    const { data: inv } = await db.from("invoices").select("amount_due").eq("project_id", projectId).gt("amount_due", 0).limit(1);
    if (!inv?.length) await db.from("projects").update({ stage: "complete" }).eq("id", projectId);
  }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}
