"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncReports } from "@/lib/sync/reports-sync";
import { scanReports, checkWaiting, checkOne, approveReport } from "@/lib/reports/pipeline";

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

/** "I'm checking this": marks the report as being checked by me for now (taking it over from anyone else). */
export async function claimReport(reportId: string) {
  const me = await requireProfile();
  await createServiceClient().from("reports").update({ claimed_by: me.id, claimed_at: new Date().toISOString() }).eq("id", reportId);
  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/reports");
}

/** "Stop checking": lets the report go back to whoever it's allocated to. */
export async function releaseReport(reportId: string) {
  await requireProfile();
  await createServiceClient().from("reports").update({ claimed_by: null, claimed_at: null }).eq("id", reportId);
  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/reports");
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
  await createServiceClient().from("reports").update({ claimed_by: me.id, claimed_at: new Date().toISOString() }).eq("id", reportId);
  try {
    await approveReport(createServiceClient(), reportId, { id: me.id, full_name: me.full_name }, { to, cc, subject: String(form.get("subject") ?? "").trim(), body: String(form.get("body") ?? "") });
  } catch (e) {
    redirect(`/reports/${reportId}?error=${encodeURIComponent(e instanceof Error ? e.message : "Couldn't approve")}`);
  }
  redirect(`/reports?sent=${encodeURIComponent(reportId)}`);
}

/** "Put on hold": sent back to the clerk for changes; nobody can send it until it's taken off hold. */
export async function holdReport(reportId: string, form: FormData) {
  const me = await requireProfile();
  const reason = String(form.get("reason") ?? "").trim().slice(0, 500) || "Waiting for the clerk's changes";
  const admin = createServiceClient();
  const { data: r } = await admin.from("reports").update({ hold_by: me.id, hold_at: new Date().toISOString(), hold_reason: reason }).eq("id", reportId).select("project_id,file_name").single();
  if (r?.project_id) await admin.from("project_events").insert({ project_id: r.project_id, source: "team", kind: "Report on hold", who: me.full_name ?? me.email, body: `${r.file_name}: ${reason}` });
  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/reports");
}

/** "Take off hold": free to send again, checked again first so the score and fixes are for the clerk's new version. */
export async function releaseHold(reportId: string) {
  const me = await requireProfile();
  const admin = createServiceClient();
  const { data: r } = await admin.from("reports").update({ hold_by: null, hold_at: null, hold_reason: null }).eq("id", reportId).select("project_id,file_name,status").single();
  if (r?.project_id) await admin.from("project_events").insert({ project_id: r.project_id, source: "team", kind: "Report off hold", who: me.full_name ?? me.email, body: `${r.file_name}: taken off hold and checked again` });
  if (r && ["ready", "failed"].includes(r.status)) {
    try { await checkOne(admin, reportId); } catch (e) {
      await admin.from("reports").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 500) }).eq("id", reportId);
    }
  }
  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/reports");
}

/** "Make a clean PDF": the office PC makes the PDF (fixes accepted, no markup) and saves it beside the report; no email. */
export async function makeCleanPdf(reportId: string) {
  const me = await requireProfile();
  try {
    await approveReport(createServiceClient(), reportId, { id: me.id, full_name: me.full_name }, { to: [], cc: [], subject: "", body: "", pdfOnly: true });
  } catch (e) {
    redirect(`/reports/${reportId}?error=${encodeURIComponent(e instanceof Error ? e.message : "Couldn't ask for the PDF")}`);
  }
  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/reports");
}

/** Correct a report's visit date by hand (Ronan, 17 Nov 2026); it then isn't replaced by the check. */
export async function setVisitDate(reportId: string, form: FormData) {
  await requireProfile();
  const d = String(form.get("visit_date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  await createServiceClient().from("reports").update({ visit_date: d, visit_date_source: "manual", updated_at: new Date().toISOString() }).eq("id", reportId);
  revalidatePath(`/reports/${reportId}`);
  revalidatePath("/reports");
}

export async function markDone(reportId: string) {
  const me = await requireProfile();
  await createServiceClient().from("reports").update({ status: "done", done_at: new Date().toISOString(), sent_by: me.id, claimed_by: null, claimed_at: null, updated_at: new Date().toISOString() }).eq("id", reportId);
  redirect("/reports");
}

export async function ignoreReport(reportId: string) {
  await requireProfile();
  await createServiceClient().from("reports").update({ status: "ignored", claimed_by: null, claimed_at: null, updated_at: new Date().toISOString() }).eq("id", reportId);
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

/** The note to the clerk about their report: sent from the checker's own email when they click Send (edited or as drafted). */
export async function sendClerkEmail(reportId: string, form: FormData) {
  const me = await requireProfile();
  const to = emails(form.get("to"));
  if (!to.length) redirect(`/reports/${reportId}?error=${encodeURIComponent("Add the clerk's email address")}`);
  const admin = createServiceClient();
  try {
    const { sendReportEmail } = await import("@/lib/google-user");
    const { withExamples } = await import("@/lib/reports/examples");
    // example lines left in the draft become the pictures from Christian's report
    const body = String(form.get("body") ?? "");
    const { html, inline } = await withExamples(admin, body);
    await sendReportEmail(admin, me.id, { to, cc: emails(form.get("cc")), subject: String(form.get("subject") ?? "").trim(), body, ...(inline.length ? { html, inline } : {}) });
  } catch (e) {
    redirect(`/reports/${reportId}?error=${encodeURIComponent(e instanceof Error ? e.message : "Couldn't send")}`);
  }
  // "hold the report until they've sent the changes" ticked: on hold in the same go
  const hold = form.get("hold") === "on" ? { hold_by: me.id, hold_at: new Date().toISOString(), hold_reason: String(form.get("hold_reason") ?? "").trim().slice(0, 500) || `Feedback emailed to the clerk ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" })}: waiting for their changes` } : {};
  const { data: r } = await admin.from("reports").update({ clerk_email_sent_at: new Date().toISOString(), clerk_email_sent_by: me.id, ...hold }).eq("id", reportId).select("project_id,file_name").single();
  if (r?.project_id) await admin.from("project_events").insert({ project_id: r.project_id, source: "team", kind: "Clerk feedback", who: me.full_name ?? me.email, body: `Feedback on ${r.file_name} emailed to ${to.join(", ")}` });
  redirect(`/reports/${reportId}?clerk=sent`);
}
