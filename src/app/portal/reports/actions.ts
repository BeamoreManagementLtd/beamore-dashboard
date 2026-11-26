"use server";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { randomUUID } from "crypto";
import { precheckOne, failPrecheck, PRECHECK_BUCKET } from "@/lib/reports/precheck";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";

/** The emails are the clerk's own choice (Ronan, 17 Nov 2026); the feedback itself is on for everyone (26 Nov 2026). */
export async function setAiFeedbackEmail(form: FormData) {
  const me = await requirePortalUser();
  if (!me.clerk || me.viewingAs) return;
  await createServiceClient().from("clerks").update({ ai_feedback_email: form.get("on") === "1", ai_feedback_changed_at: new Date().toISOString() }).eq("id", me.clerk.id);
  revalidatePath("/portal"); revalidatePath("/portal/reports");
}

/**
 * Check a draft report before it goes in Google Drive (Ronan, 18 Nov 2026). Step 1: a place to upload it to. The
 * draft goes to the dashboard's own storage, never to Drive or the office, and is removed once it has been checked.
 */
export async function startPrecheck(a: { projectId: string; fileName: string; bytes: number }) {
  const me = await requirePortalUser();
  if (!me.clerk) return { ok: false as const, message: "Only clerks can check reports here." };
  if (me.viewingAs) return { ok: false as const, message: "You're viewing as this clerk, so checks are switched off." };
  if (!/\.docx$/i.test(a.fileName)) return { ok: false as const, message: "Please choose the Word file (.docx) of your report." };
  if (a.bytes > 50 * 1024 * 1024) return { ok: false as const, message: "That file is over 50 MB. Shrinking the photos first (in Word: Picture Format > Compress Pictures) will bring it down." };
  const admin = createServiceClient();
  const { data: p } = await admin.from("projects").select("id,clerk_id,clerk_me_id").eq("id", a.projectId).maybeSingle();
  if (!p || (p.clerk_id !== me.clerk.id && p.clerk_me_id !== me.clerk.id)) return { ok: false as const, message: "Please choose one of your jobs." };
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const { count } = await admin.from("report_prechecks").select("id", { count: "exact", head: true }).eq("clerk_id", me.clerk.id).gte("created_at", dayAgo);
  if ((count ?? 0) >= 15) return { ok: false as const, message: "That's 15 checks in the last day, the most for now. Please try again tomorrow." };
  const id = randomUUID();
  const safe = a.fileName.replace(/[^\w.\- ()]+/g, "_").slice(-120) || "report.docx";
  const path = `${me.clerk.id}/${id}/${safe}`;
  const kind = p.clerk_me_id === me.clerk.id && p.clerk_id !== me.clerk.id ? "me" : "building";
  const { error } = await admin.from("report_prechecks").insert({ id, clerk_id: me.clerk.id, project_id: p.id, kind, file_name: a.fileName.slice(0, 200), storage_path: path, bytes: a.bytes });
  if (error) return { ok: false as const, message: "Couldn't start the check. Please try again." };
  const { data, error: e2 } = await admin.storage.from(PRECHECK_BUCKET).createSignedUploadUrl(path);
  if (e2 || !data) return { ok: false as const, message: "Couldn't start the check. Please try again." };
  return { ok: true as const, id, path, token: data.token };
}

/** Step 2: the draft has arrived; the check runs straight away (about two minutes), and the 15-minute job catches any left over. */
export async function finishPrecheck(id: string) {
  const me = await requirePortalUser();
  if (!me.clerk) return { ok: false as const };
  const admin = createServiceClient();
  const { data: pc } = await admin.from("report_prechecks").update({ status: "waiting" }).eq("id", id).eq("clerk_id", me.clerk.id).eq("status", "uploading").select("id").maybeSingle();
  if (!pc) return { ok: false as const };
  after(() => precheckOne(admin, id).catch((e) => failPrecheck(admin, id, e)));
  return { ok: true as const };
}
