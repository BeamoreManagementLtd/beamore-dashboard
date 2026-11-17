import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { clerkSheet } from "@/lib/project-facts";

export const dynamic = "force-dynamic";

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
          {s!.folder && <p className="small"><a href={s!.folder} target="_blank" rel="noopener">Project folder ↗</a> (programme, CPs, drawings, your reports)</p>}
        </section>
      ))}
    </>
  );
}
