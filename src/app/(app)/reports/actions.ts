"use server";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncReports } from "@/lib/sync/reports-sync";

/** Anyone on the team can refresh the reports lists (it only reads the two Drive files). */
export async function refreshReports() {
  await requireProfile();
  const r = await syncReports(createServiceClient(), { force: true });
  redirect(r.ok ? "/reports?refreshed=1" : `/reports?error=${encodeURIComponent(r.message)}`);
}
