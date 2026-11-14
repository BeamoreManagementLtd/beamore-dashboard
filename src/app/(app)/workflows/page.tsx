import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadWorkflows, WORKFLOW_COLUMNS, type Status, type WorkflowProject } from "@/lib/workflow";

export const dynamic = "force-dynamic";

const COLUMNS = [
  { key: "pricing", title: "Pricing" },
  { key: "setup", title: "Set-up" },
  { key: "live", title: "Live" },
  { key: "closeout", title: "Close-out" },
] as const;
const WHO: Record<NonNullable<Status["waitingOn"]>, string> = { us: "us", client: "the client", you: "Ronan", admin: "the admin team", clerk: "the clerk" };

/** Every active project as a card in its workflow stage, with who it's waiting on. */
export default async function Workflows({ searchParams }: { searchParams: Promise<{ who?: string; old?: string }> }) {
  await requireProfile();
  const { who, old } = await searchParams;
  const db = await createClient();
  const { data } = await db.from("projects").select(`${WORKFLOW_COLUMNS},display_name,clients(name)`)
    .in("stage", ["enquiry", "pricing", "sent", "won_arranging", "won_preparing", "live", "on_hold"]).order("name");
  const projects = (data ?? []) as unknown as (WorkflowProject & { display_name: string; clients: { name: string } | null })[];
  const wf = await loadWorkflows(db, projects);

  // enquiries imported from the register with no date and no activity are parked out of the way unless asked for
  const parked = (p: (typeof projects)[number]) => !p.stage_changed_at && (p.stage === "enquiry" || p.stage === "pricing");
  const cards = projects.map((p) => ({ p, w: wf.get(p.id)! }))
    .filter(({ p }) => old === "1" || !parked(p))
    .filter(({ w }) => !who || w.status.waitingOn === who);
  const parkedCount = projects.filter(parked).length;
  const counts = new Map<string, number>();
  for (const { p, w } of projects.map((p) => ({ p, w: wf.get(p.id)! }))) if (!parked(p) && w.status.waitingOn) counts.set(w.status.waitingOn, (counts.get(w.status.waitingOn) ?? 0) + 1);
  const q = (o: Record<string, string | undefined>) => {
    const s = new URLSearchParams(Object.entries({ who, old, ...o }).filter(([, v]) => v) as [string, string][]).toString();
    return s ? `?${s}` : "/workflows";
  };

  return (
    <>
      <div className="head"><div>
        <h1>Workflows</h1>
        <p>Every active project in its stage, with where it’s up to and who it’s waiting on. Open a card for the full workflow.</p>
      </div></div>
      <div className="wb-filters">
        <Link href={q({ who: undefined })} className={`chip ${!who ? "on" : ""}`}>Everything</Link>
        {(Object.keys(WHO) as (keyof typeof WHO)[]).filter((k) => counts.get(k)).map((k) => (
          <Link key={k} href={q({ who: k })} className={`chip ${who === k ? "on" : ""}`}>Waiting on {WHO[k]} · {counts.get(k)}</Link>
        ))}
        {parkedCount > 0 && <Link href={q({ old: old === "1" ? undefined : "1" })} className="chip">{old === "1" ? "Hide" : "Show"} {parkedCount} older enquiries</Link>}
      </div>
      <div className="wb">
        {COLUMNS.map((c) => {
          const col = cards.filter(({ w }) => w.current === c.key)
            .sort((a, b) => (b.w.status.waitingOn ? 1 : 0) - (a.w.status.waitingOn ? 1 : 0) || (b.w.status.days ?? -1) - (a.w.status.days ?? -1));
          return (
            <section key={c.key} className="wb-col">
              <h2>{c.title} <span className="muted small">{col.length}</span></h2>
              {col.map(({ p, w }) => {
                const st = w.stages.find((s) => s.key === c.key)!;
                const done = st.steps.filter((x) => x.state === "done").length;
                return (
                  <Link key={p.id} href={`/projects/${p.id}`} className={`wb-card ${w.status.waitingOn ? `w-${w.status.waitingOn}` : ""}`}>
                    <div className="wb-top"><b>{p.display_name}</b>{c.key !== "live" && <span className="muted small">{done}/{st.steps.length}</span>}</div>
                    {p.clients?.name && <div className="small muted">{p.clients.name}{p.is_dfe ? " · DfE" : ""}</div>}
                    {w.status.waitingOn && <span className={`pill ${w.status.waitingOn === "client" ? "neutral" : "warn"}`}>Waiting on {WHO[w.status.waitingOn]}{w.status.days ? ` · ${w.status.days}d` : ""}</span>}
                    <p className="small">{w.status.text}</p>
                  </Link>
                );
              })}
              {!col.length && <p className="small muted">Nothing here.</p>}
            </section>
          );
        })}
      </div>
    </>
  );
}
