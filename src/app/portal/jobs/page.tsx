import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { clerkSheet } from "@/lib/project-facts";

export const dynamic = "force-dynamic";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const n1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** The job's inspection schedule: planned days on site each month (days only, nothing financial). */
function Schedule({ plan, agreed }: { plan: { month: string; building: number; me: number; witness: number }[]; agreed: string[] }) {
  if (!plan.length && !agreed.length) return null;
  const now = new Date().toISOString().slice(0, 7);
  const me = plan.some((p) => p.me), bld = plan.some((p) => p.building);
  return (
    <div style={{ marginTop: 12 }}>
      <h3 style={{ margin: "0 0 4px" }}>Inspection schedule</h3>
      {agreed.map((a) => <p key={a} className="small" style={{ margin: "2px 0" }}>{a}</p>)}
      {!!plan.length && (
        <>
          <p className="small muted" style={{ margin: "2px 0 6px" }}>Planned days on site each month, from the agreed schedule. Your diary dates may move with the programme; let the office know if the job needs more or fewer days.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="small" style={{ minWidth: 60 + plan.length * 52 }}><tbody>
              <tr><td></td>{plan.map((p) => <th key={p.month} style={{ textAlign: "center", fontWeight: p.month.slice(0, 7) === now ? 700 : 500, background: p.month.slice(0, 7) === now ? "var(--surface-2, #f3f3f3)" : undefined }}>{MON[Number(p.month.slice(5, 7)) - 1]} {p.month.slice(2, 4)}</th>)}</tr>
              {bld && <tr><td style={{ whiteSpace: "nowrap", paddingRight: 8 }}><b>Building</b></td>{plan.map((p) => <td key={p.month} style={{ textAlign: "center" }}>{p.building ? n1(p.building) : "·"}</td>)}</tr>}
              {me && <tr><td style={{ whiteSpace: "nowrap", paddingRight: 8 }}><b>M&amp;E</b></td>{plan.map((p) => <td key={p.month} style={{ textAlign: "center" }}>{p.me ? n1(p.me) : "·"}</td>)}</tr>}
              {plan.some((p) => p.witness) && <tr><td className="muted" style={{ whiteSpace: "nowrap", paddingRight: 8 }}>of which witnessing / snagging</td>{plan.map((p) => <td key={p.month} className="muted" style={{ textAlign: "center" }}>{p.witness ? n1(p.witness) : ""}</td>)}</tr>}
            </tbody></table>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * A clerk's jobs and what they need to know for each (Ronan, 17 Nov 2026): the contacts and numbers the client gave,
 * who reports go to, the project folder. Only jobs they're allocated to now; nothing financial.
 */
export default async function MyJobs() {
  const me = await requirePortalUser();
  if (!me.clerk) return <section className="card"><h1>Your jobs</h1><p className="muted">Clerks see the jobs they&apos;re on here.</p></section>;
  const db = createServiceClient();
  const { data: jobs } = await db.from("projects").select("id,display_name,stage")
    .or(`clerk_id.eq.${me.clerk.id},clerk_me_id.eq.${me.clerk.id}`).in("stage", ["won_arranging", "won_preparing", "live", "on_hold"]).order("name");
  const sheets = (await Promise.all((jobs ?? []).map((j) => clerkSheet(db, j.id)))).filter(Boolean);
  return (
    <>
      <h1>Your jobs</h1>
      <p className="muted">The details the client has given us for each job you&apos;re on. If something here is out of date, let the office know.</p>
      {!sheets.length && <section className="card"><p className="muted">You&apos;re not on any jobs at the moment.</p></section>}
      {sheets.map((s) => (
        <section key={s!.project} className="card" style={{ marginBottom: 14 }}>
          <h2 style={{ marginTop: 0 }}>{s!.project}</h2>
          {(s!.client || s!.site) && <p className="muted" style={{ marginTop: -6 }}>{[s!.client, s!.site].filter(Boolean).join(" · ")}</p>}
          {!s!.lines.length ? <p className="muted">No details from the client yet. We&apos;ll email you when they come in.</p> : (
            <table><tbody>{s!.lines.map((l) => (
              <tr key={l.label}><td style={{ verticalAlign: "top", whiteSpace: "nowrap", paddingRight: 12 }}><b>{l.label}</b></td><td style={{ whiteSpace: "pre-wrap" }}>{l.value}</td></tr>
            ))}</tbody></table>
          )}
          <Schedule plan={s!.plan} agreed={s!.agreed} />
          {s!.folder && <p className="small"><a href={s!.folder} target="_blank" rel="noopener">Project folder ↗</a> (programme, CPs, drawings, your reports)</p>}
        </section>
      ))}
    </>
  );
}
