"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncReports } from "@/lib/sync/reports-sync";
import { scanReports, checkWaiting, checkOne, approveAndSend } from "@/lib/reports/pipeline";

const emails = (s: FormDataEntryValue | null) => [...new Set((String(s ?? "").match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []))];

/** Anyone on the team: look for new reports now (and check a few), instead of waiting for the 15-minute run. */
export async function refreshReports() {
  await requireProfile();
  const admin = createServiceClient();
  try {
    const s = await scanReports(admin);
    const c = await checkWaiting(admin, 45_000);
    await syncReports(admin).catch(() => undefined); // the old spreadsheets too, while they're still running
    redirect(`/reports?refreshed=${encodeURIComponent(`${s.found} new, ${s.done} now have a PDF, ${c.checked} checked`)}`);
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // redirect
    redirect(`/reports?error=${encodeURIComponent(e instanceof Error ? e.message : "failed")}`);
  }
}

export async function assignChecker(reportId: string, form: FormData) {
  await requireProfile();
  const who = String(form.get("checker") ?? "") || null;
  const admin = createServiceClient();
  const { data: r } = await admin.from("reports").update({ checker_id: who, updated_at: new Date().toISOString() }).eq("id", reportId).select("project_id").single();
  // the project's future reports go to the same person
  if (r?.project_id && form.get("for_project") === "on") await admin.from("projects").update({ report_checker_id: who }).eq("id", r.project_id);
  revalidatePath(`/reports/${reportId}`);
}

export async function setProjectChecker(projectId: string, form: FormData) {
  await requireProfile();
  const who = String(form.get("checker") ?? "") || null;
  const admin = createServiceClient();
  await admin.from("projects").update({ report_checker_id: who }).eq("id", projectId);
  await admin.from("reports").update({ checker_id: who }).eq("project_id", projectId).in("status", ["new", "checking", "ready", "failed"]);
  revalidatePath(`/projects/${projectId}`);
}

export async function sendReport(reportId: string, form: FormData) {
  const me = await requireProfile();
  const to = emails(form.get("to")), cc = emails(form.get("cc"));
  try {
    await approveAndSend(createServiceClient(), reportId, { id: me.id, full_name: me.full_name }, { to, cc, subject: String(form.get("subject") ?? "").trim(), body: String(form.get("body") ?? "") });
  } catch (e) {
    redirect(`/reports/${reportId}?error=${encodeURIComponent(e instanceof Error ? e.message : "Couldn't send")}`);
  }
  redirect(`/reports?sent=${encodeURIComponent(reportId)}`);
}

export async function markDone(reportId: string) {
  const me = await requireProfile();
  await createServiceClient().from("reports").update({ status: "done", done_at: new Date().toISOString(), sent_by: me.id, updated_at: new Date().toISOString() }).eq("id", reportId);
  redirect("/reports");
}

export async function ignoreReport(reportId: string) {
  await requireProfile();
  await createServiceClient().from("reports").update({ status: "ignored", updated_at: new Date().toISOString() }).eq("id", reportId);
  redirect("/reports");
}

export async function checkAgain(reportId: string) {
  await requireProfile();
  const admin = createServiceClient();
  try { await checkOne(admin, reportId); } catch (e) {
    await admin.from("reports").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).eq("id", reportId);
  }
  revalidatePath(`/reports/${reportId}`);
}

export async function saveSettings(form: FormData) {
  const me = await requireProfile();
  const n = (k: string) => Math.max(0, Math.min(10, Number(form.get(k) ?? 1) || 0));
  await createServiceClient().from("report_settings").update({
    email_subject: String(form.get("subject") ?? "").trim().slice(0, 300), email_body: String(form.get("body") ?? "").slice(0, 5000),
    clerk_days: n("clerk_days"), team_days: n("team_days"), updated_at: new Date().toISOString(), updated_by: me.full_name ?? me.email,
  }).eq("id", 1);
  redirect("/reports/settings?saved=1");
}
