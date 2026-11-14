import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd } from "@/lib/format";

export const dynamic = "force-dynamic";

const STAGES: [string, string][] = [
  ["live", "Live"], ["pricing", "Pricing"], ["sent", "Sent – awaiting reply"], ["won_arranging", "Won – arranging clerk"],
  ["won_preparing", "Won – preparing to start"], ["enquiry", "Enquiry"], ["on_hold", "On hold"], ["lost", "Lost"], ["complete", "Complete"],
];

export default async function Projects({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  await requireProfile();
  const { stage = "live" } = await searchParams;
  const db = await createClient();
  const [{ data: rows }, { data: counts }] = await Promise.all([
    db.from("projects").select("id,display_name,stage,agreed_days_building,agreed_days_me,next_action,next_action_due,clients(name)").eq("stage", stage).order("name"),
    db.from("projects").select("stage"),
  ]);
  const n = (s: string) => (counts ?? []).filter((c) => c.stage === s).length;

  return (
    <>
      <div className="head"><div><h1>Projects</h1><p>From the Cost Proposals Register. Money columns are on the director’s view only.</p></div></div>
      <nav className="row">
        {STAGES.map(([k, l]) => (
          <a key={k} href={`/projects?stage=${k}`} className={`btn ${k === stage ? "primary" : ""}`}>{l} <span className="small">{n(k)}</span></a>
        ))}
      </nav>
      <section className="panel">
        {!rows?.length ? <p className="empty">No projects at this stage yet.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Project</th><th>Client</th><th className="num">Agreed days</th><th>Next action</th></tr></thead>
            <tbody>
              {rows.map((p) => {
                const days = (Number(p.agreed_days_building ?? 0) + Number(p.agreed_days_me ?? 0)) || null;
                return (
                  <tr key={p.id}>
                    <td><b>{p.display_name}</b></td>
                    <td>{(p.clients as unknown as { name: string } | null)?.name}</td>
                    <td className="num">{days ?? "—"}</td>
                    <td>{p.next_action ?? <span className="muted">Not set</span>}<span className="two">{fd(p.next_action_due)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
