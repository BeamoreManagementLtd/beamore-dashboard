"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

/** How often a job's reports come (Ronan, 17 Nov 2026: "if you need to ask about the frequency, just do that"). */
export async function setReporting(form: FormData) {
  await requireProfile();
  const id = String(form.get("project") ?? ""), v = String(form.get("value") ?? "");
  if (!id || !v) return;
  const admin = createServiceClient();
  if (v === "elsewhere") await admin.from("projects").update({ reports_elsewhere: String(form.get("where") ?? "FieldView") || "FieldView" }).eq("id", id);
  else if (v === "drive") await admin.from("projects").update({ reports_elsewhere: null }).eq("id", id);
  else await admin.from("projects").update({ reporting_frequency: v, reports_elsewhere: null }).eq("id", id);
  revalidatePath("/reports/tracker");
}

/** A job finished (Ronan, 17 Nov 2026: "shouldn't a report disappear off it when I say that the project is closed"): marked complete, so it leaves the tracker. */
export async function finishJob(form: FormData) {
  await requireProfile();
  const id = String(form.get("project") ?? "");
  if (!id) return;
  const admin = createServiceClient();
  const { data } = await admin.from("projects").update({ stage: "complete", stage_changed_at: new Date().toISOString() }).eq("id", id).in("stage", ["live", "on_hold", "won_preparing"]).select("id");
  if (data?.length) await admin.from("project_events").insert({ project_id: id, source: "dashboard", kind: "Stage", who: "Dashboard", body: "Complete (marked finished on the report tracker)" });
  revalidatePath("/reports/tracker");
}

/** Chasing missing reports by email: off until Ronan switches it on. */
export async function setChasing(form: FormData) {
  const me = await requireProfile();
  if (me.role !== "director") return;
  await createServiceClient().from("report_settings").update({ chase_missing: form.get("on") === "1" }).eq("id", 1);
  revalidatePath("/reports/tracker");
}

/** A week no report was needed on a job (a break on site, not started yet): it stops showing as missing (Ronan, 24 Nov 2026). */
export async function weekNotNeeded(form: FormData) {
  const me = await requireProfile();
  const id = String(form.get("project") ?? ""), week = String(form.get("week") ?? "");
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(week)) return;
  const admin = createServiceClient();
  const { data: p } = await admin.from("projects").select("details").eq("id", id).single();
  const det = (p?.details ?? {}) as { no_report_weeks?: string[] };
  await admin.from("projects").update({ details: { ...det, no_report_weeks: [...new Set([...(det.no_report_weeks ?? []), week])].sort() } }).eq("id", id);
  await admin.from("project_events").insert({ project_id: id, source: "team", kind: "Report tracker", who: me.full_name ?? me.email, body: `No report needed for the week of ${week}` });
  revalidatePath("/reports/tracker");
}
