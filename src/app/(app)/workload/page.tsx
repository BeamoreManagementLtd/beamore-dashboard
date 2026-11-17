import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadWorkload } from "@/lib/workload";
import { today } from "@/lib/format";
import { WorkloadView } from "./workload-view";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // "Re-read cost schedules" goes through every project folder

/**
 * Workload (Ronan, 17 Nov 2026): looking ahead to the end of 2028, does each clerk of works have the days for the work they're
 * allocated, and who is going quiet and could take more. Building clerks first, M&E clerks below.
 */
export default async function WorkloadPage() {
  await requireProfile();
  const db = await createClient();
  // to the end of 2028 (Ronan, 17 Nov 2026), and never less than a year
  const t = today();
  const n = Math.max(13, (2028 - Number(t.slice(0, 4))) * 12 + 12 - Number(t.slice(5, 7)) + 1);
  const w = await loadWorkload(db, t, n);
  const [{ data: run }, { data: clerks }, { data: jobs }] = await Promise.all([
    db.from("sync_runs").select("finished_at,ok").eq("source", "proposals").order("started_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("clerks").select("id,name").eq("active", true).order("name"),
    db.from("projects").select("id,number,name,display_name").in("stage", ["sent", "won_arranging", "won_preparing", "live", "on_hold"]).order("name"),
  ]);
  const choices = {
    clerks: (clerks ?? []).map((c) => ({ id: c.id as string, name: c.name as string })),
    jobs: (jobs ?? []).map((p) => ({ id: p.id as string, name: (p.display_name ?? p.name) as string })),
  };
  return <WorkloadView w={w} lastRead={run?.finished_at ?? null} choices={choices} today={t} />;
}
