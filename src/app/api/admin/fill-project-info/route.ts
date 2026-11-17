import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readClientInfo, readReportInfo } from "@/lib/project-facts";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * One-off catch-up (Ronan, 17 Nov 2026: "yes, fill them in" ... "get all the information you can from their diaries, the most
 * recent diary, because some people change"): for live / waiting jobs, the clerk's latest report first (replacing older
 * answers from emails or diaries, never one typed in by hand), then the client's emails for anything still blank.
 * Never emails anyone. Director only. POST { after?: project id } — works through the jobs in name order for up to ~4 minutes and says where it stopped, to be called again from there.
 */
export async function POST(req: Request) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  const { data: me } = user ? await db.from("profiles").select("role").eq("id", user.id).maybeSingle() : { data: null };
  if (me?.role !== "director") return NextResponse.json({ error: "director only" }, { status: 403 });
  const admin = createServiceClient();
  const { after, only } = (await req.json().catch(() => ({}))) as { after?: string; only?: string };
  const { data: jobs } = await admin.from("projects").select("id,name").in("stage", ["won_arranging", "won_preparing", "live", "on_hold"]).order("name").order("id");
  // { only: project id }: just that job (e.g. after it's turned out to be DfE and has the DfE checklist)
  const list = only ? (jobs ?? []).filter((j) => j.id === only) : jobs ?? [];
  const start = after ? list.findIndex((j) => j.id === after) + 1 : 0;
  const t0 = Date.now(), done: string[] = [];
  let filled = 0, last: string | null = after ?? null;
  for (const j of list.slice(start)) {
    if (Date.now() - t0 > 230_000) break;
    last = j.id;
    const { data: rows0 } = await admin.from("project_info").select("id").eq("project_id", j.id).limit(1);
    if (!rows0?.length) continue;
    try {
      let n = 0, fromReport = 0;
      // 1. the clerk's most recent report: up to date (people change), so it replaces older answers from emails or
      //    diaries, never one typed in by hand
      const rep = await readReportInfo(admin, j.id);
      const { data: rows } = await admin.from("project_info").select("id,value,value_from").eq("project_id", j.id);
      for (const [id, v] of Object.entries(rep.values)) {
        const row = (rows ?? []).find((x) => x.id === id);
        if (!row || row.value_from === "manual" || (row.value ?? "").trim() === v) continue;
        await admin.from("project_info").update({ value: v, value_from: "report", value_at: new Date().toISOString() }).eq("id", id);
        n++; fromReport++;
      }
      // 2. the client's emails for anything still blank
      const { data: still } = await admin.from("project_info").select("id").eq("project_id", j.id).is("value", null).limit(1);
      if (still?.length) {
        const r = await readClientInfo(admin, j.id);
        for (const [id, v] of Object.entries(r.values)) {
          const { data: up } = await admin.from("project_info").update({ value: v, value_from: "email", value_at: new Date().toISOString() }).eq("id", id).is("value", null).select("id");
          if (up?.length) n++;
        }
      }
      if (n) {
        filled += n; done.push(`${j.name}: ${n}${fromReport ? ` (${fromReport} from ${rep.from})` : ""}`);
        await admin.from("project_events").insert({ project_id: j.id, source: "dashboard", kind: "Info received", who: "Dashboard", body: `${n} item${n === 1 ? "" : "s"} of project information filled in${fromReport ? `, ${fromReport} from the latest report (${rep.from})` : ""}${n - fromReport ? `, ${n - fromReport} from the client's emails` : ""} (catch-up, not sent to anyone)` });
      }
    } catch (e) { done.push(`${j.name}: ${e instanceof Error ? e.message.slice(0, 60) : "failed"}`); }
  }
  const finished = !last || list.findIndex((j) => j.id === last) >= list.length - 1;
  return NextResponse.json({ filled, jobs: list.length, done, after: last, finished });
}
