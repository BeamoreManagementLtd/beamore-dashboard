import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { readClientInfo } from "@/lib/project-facts";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * One-off catch-up (Ronan, 17 Nov 2026: "yes, fill them in"): reads the client's emails for live / waiting jobs and fills
 * in checklist items that have no answer yet (the DfE project manager etc. on jobs set up before answers were kept).
 * Never overwrites an answer, never emails anyone. Director only. POST { after?: project id } — works through the jobs
 * in name order for up to ~4 minutes and says where it stopped, to be called again from there.
 */
export async function POST(req: Request) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  const { data: me } = user ? await db.from("profiles").select("role").eq("id", user.id).maybeSingle() : { data: null };
  if (me?.role !== "director") return NextResponse.json({ error: "director only" }, { status: 403 });
  const admin = createServiceClient();
  const { after } = (await req.json().catch(() => ({}))) as { after?: string };
  const { data: jobs } = await admin.from("projects").select("id,name").in("stage", ["won_arranging", "won_preparing", "live", "on_hold"]).order("name").order("id");
  const list = jobs ?? [];
  const start = after ? list.findIndex((j) => j.id === after) + 1 : 0;
  const t0 = Date.now(), done: string[] = [];
  let filled = 0, last: string | null = after ?? null;
  for (const j of list.slice(start)) {
    if (Date.now() - t0 > 230_000) break;
    last = j.id;
    const { data: open } = await admin.from("project_info").select("id").eq("project_id", j.id).is("value", null).limit(1);
    if (!open?.length) continue;
    try {
      const r = await readClientInfo(admin, j.id);
      const { data: rows } = await admin.from("project_info").select("id,value").eq("project_id", j.id);
      let n = 0;
      for (const [id, v] of Object.entries(r.values)) {
        if ((rows ?? []).find((x) => x.id === id)?.value) continue;
        await admin.from("project_info").update({ value: v, value_from: "email", value_at: new Date().toISOString() }).eq("id", id).is("value", null);
        n++;
      }
      if (n) {
        filled += n; done.push(`${j.name}: ${n}`);
        await admin.from("project_events").insert({ project_id: j.id, source: "dashboard", kind: "Info received", who: "Dashboard", body: `${n} item${n === 1 ? "" : "s"} of project information filled in from the client's emails (catch-up, not sent to anyone)` });
      }
    } catch (e) { done.push(`${j.name}: ${e instanceof Error ? e.message.slice(0, 60) : "failed"}`); }
  }
  const finished = !last || list.findIndex((j) => j.id === last) >= list.length - 1;
  return NextResponse.json({ filled, jobs: list.length, done, after: last, finished });
}
