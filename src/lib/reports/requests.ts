import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What the office has asked a clerk to do better from next week (Ronan, 23 Nov 2026). Kept with the job (project and
 * building / M&E), so it shows on the job's following reports until someone marks it done: whoever checks next week
 * sees it was already asked (e.g. "start from last week's report downloaded from the Drive") and pushes back rather
 * than asking again. Each later report it still isn't done on is noted against it.
 */
export type Missed = { report: string; file: string; at: string; by: string | null };
export type ClerkRequest = { id: string; text: string; asked_by: string | null; asked_at: string; asked_on_report: string | null; status: string; missed: Missed[] };

type Rep = { id: string; project_id: string | null; project_folder_name: string | null; kind: string; uploaded_at?: string };

/** The open requests for this report's job (those asked on this report included). */
export async function openRequests(admin: SupabaseClient, r: Rep) {
  const base = admin.from("report_requests").select("id,text,asked_by,asked_at,asked_on_report,status,missed").eq("kind", r.kind).eq("status", "open");
  const { data } = await (r.project_id ? base.eq("project_id", r.project_id) : base.is("project_id", null).eq("project_folder_name", r.project_folder_name ?? "")).order("asked_at");
  return (data ?? []) as ClerkRequest[];
}

/** Open requests asked on an earlier report, per job key ("project_id:kind" or "folder:kind"), for the queue. */
export async function openRequestCounts(admin: SupabaseClient) {
  const { data } = await admin.from("report_requests").select("project_id,project_folder_name,kind,asked_on_report").eq("status", "open");
  return (data ?? []) as { project_id: string | null; project_folder_name: string | null; kind: string; asked_on_report: string | null }[];
}
export const requestKey = (r: { project_id: string | null; project_folder_name: string | null; kind: string }) => `${r.project_id ?? `folder:${r.project_folder_name ?? ""}`}:${r.kind}`;
