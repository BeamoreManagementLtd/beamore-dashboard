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
  if (outcome === "won") {
    const { onWon } = await import("@/lib/project-setup");
    const { createServiceClient } = await import("@/lib/supabase/server");
    await onWon(createServiceClient(), projectId);
  }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/workflows");
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

/** S4: which kind of folder (DfE school, other school, other, cladding); makes or fixes the Drive folder. */
export async function setFolderKind(projectId: string, form: FormData) {
  await requireProfile();
  const kind = String(form.get("kind") ?? "");
  const { FOLDER_KINDS, ensureProjectFolder } = await import("@/lib/project-setup");
  if (!(kind in FOLDER_KINDS)) return;
  const { createServiceClient } = await import("@/lib/supabase/server");
  const admin = createServiceClient();
  await admin.from("projects").update({ folder_kind: kind }).eq("id", projectId);
  try { await ensureProjectFolder(admin, projectId); } catch (e) {
    await admin.from("project_events").insert({ project_id: projectId, source: "dashboard", kind: "Set-up problem", who: "Dashboard", body: `Drive folder not done yet: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
  }
  revalidatePath(`/projects/${projectId}`);
}

/** S2: (re)make the Gmail draft asking the client for the outstanding items. Only ever a draft. */
export async function redraftInfoRequest(projectId: string) {
  await requireProfile();
  const { draftInfoRequest } = await import("@/lib/project-setup");
  const { createServiceClient } = await import("@/lib/supabase/server");
  const admin = createServiceClient();
  try { await draftInfoRequest(admin, projectId); } catch (e) {
    await admin.from("project_events").insert({ project_id: projectId, source: "dashboard", kind: "Set-up problem", who: "Dashboard", body: `Info request draft not done: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
  }
  revalidatePath(`/projects/${projectId}`);
}

// ---- find a clerk (workflow 3)
export async function saveClerkNeeds(projectId: string, form: FormData) {
  await requireProfile();
  const db = await createClient();
  const v = (k: string) => String(form.get(k) ?? "").trim() || null;
  await db.from("projects").update({ start_date: v("start_date"), visits_per_week: v("visits_per_week") ? Number(v("visits_per_week")) : null, clerk_needed: v("clerk_needed") }).eq("id", projectId);
  revalidatePath(`/projects/${projectId}`);
}

export async function addCandidate(projectId: string, clerkId: string | null, name: string, form: FormData) {
  const n = name || String(form.get("name") ?? "").trim();
  if (!n) return;
  const { db } = await workflowLog(projectId, "Clerk search", `Approached ${n}`);
  await db.from("clerk_candidates").insert({ project_id: projectId, clerk_id: clerkId, name: n, note: String(form.get("note") ?? "").trim() || null });
  revalidatePath(`/projects/${projectId}`);
}

export async function setCandidateStatus(projectId: string, candidateId: string, form: FormData) {
  await requireProfile();
  const db = await createClient();
  const status = String(form.get("status") ?? "");
  if (!["approached", "interested", "interviewed", "references", "declined"].includes(status)) return;
  await db.from("clerk_candidates").update({ status, updated_at: new Date().toISOString() }).eq("id", candidateId).eq("project_id", projectId);
  revalidatePath(`/projects/${projectId}`);
}

/** C4: an existing clerk becomes the project's clerk; someone new goes to Personnel to be added and onboarded. */
export async function appointCandidate(projectId: string, candidateId: string) {
  await requireProfile();
  const db = await createClient();
  const { data: c } = await db.from("clerk_candidates").select("clerk_id,name").eq("id", candidateId).single();
  if (!c) return;
  await db.from("clerk_candidates").update({ status: "appointed", updated_at: new Date().toISOString() }).eq("id", candidateId);
  if (c.clerk_id) {
    await workflowLog(projectId, "Clerk of works", `${c.name} appointed`);
    await db.from("projects").update({ clerk_id: c.clerk_id, clerk_status: "have" }).eq("id", projectId);
    revalidatePath(`/projects/${projectId}`);
    return;
  }
  const { redirect } = await import("next/navigation");
  redirect(`/personnel?project=${projectId}&name=${encodeURIComponent(c.name)}#new`);
}

// ---- P1: pricing requests spotted in email
export async function createFromRequest(requestId: string, form: FormData) {
  const me = await requireProfile();
  const db = await createClient();
  const name = String(form.get("name") ?? "").trim();
  const client = String(form.get("client_id") ?? "") || null;
  if (!name) return;
  const { data: req } = await db.from("price_requests").select("from_name,subject,received_at,status").eq("id", requestId).single();
  if (!req || req.status !== "new") return;
  const { data: last } = await db.from("projects").select("number").order("number", { ascending: false }).limit(1);
  const number = (last?.[0]?.number ?? 1000) + 1;
  const { data: p, error } = await db.from("projects").insert({ number, name, client_id: client, stage: "pricing" }).select("id").single();
  if (error) throw new Error(error.message);
  await db.from("price_requests").update({ status: "created", project_id: p.id }).eq("id", requestId);
  await db.from("project_events").insert({ project_id: p.id, source: "gmail", kind: "Email received", who: req.from_name,
    body: `Asked to price: "${req.subject}". Enquiry created by ${me.full_name ?? me.email}` });
  revalidatePath("/projects/requests");
  revalidatePath("/workflows");
  const { redirect } = await import("next/navigation");
  redirect(`/projects/${p.id}`);
}

export async function ignoreRequest(requestId: string) {
  await requireProfile();
  const db = await createClient();
  await db.from("price_requests").update({ status: "ignored" }).eq("id", requestId);
  revalidatePath("/projects/requests");
  revalidatePath("/due");
}

/** P4: draft a follow-up to a proposal with no reply. Only ever a draft. */
export async function draftFollowUp(projectId: string) {
  await requireProfile();
  const { draftProposalFollowUp } = await import("@/lib/project-setup");
  const { createServiceClient } = await import("@/lib/supabase/server");
  const admin = createServiceClient();
  try { await draftProposalFollowUp(admin, projectId); } catch (e) {
    await admin.from("project_events").insert({ project_id: projectId, source: "dashboard", kind: "Set-up problem", who: "Dashboard", body: `Follow-up draft not done: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) });
  }
  revalidatePath(`/projects/${projectId}`);
}

/** An applicant from email/Indeed onto a job's Find a clerk list. */
export async function addApplicant(projectId: string, applicationId: string) {
  const { db } = await workflowLog(projectId, "Clerk search", "Applicant added to the shortlist");
  const { data: a } = await db.from("job_applications").select("name,source").eq("id", applicationId).single();
  if (!a) return;
  await db.from("clerk_candidates").insert({ project_id: projectId, name: a.name, status: "applied", application_id: applicationId, note: `Applied via ${a.source ?? "email"}` });
  await db.from("job_applications").update({ status: "added", project_id: projectId }).eq("id", applicationId);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/personnel");
}

export async function dismissApplication(applicationId: string) {
  await requireProfile();
  const db = await createClient();
  await db.from("job_applications").update({ status: "dismissed" }).eq("id", applicationId);
  revalidatePath("/personnel");
}
