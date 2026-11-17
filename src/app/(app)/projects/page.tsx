import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { linkSite, ignoreSite } from "./actions";
import { createClient } from "@/lib/supabase/server";
import { fd } from "@/lib/format";
import { NewProjectForm } from "./new-project-form";

export const dynamic = "force-dynamic";

const STAGES: [string, string][] = [
  ["live", "Live"], ["pricing", "Pricing"], ["sent", "Sent – awaiting reply"], ["won_arranging", "Won – arranging clerk"],
  ["won_preparing", "Won – preparing to start"], ["enquiry", "Enquiry"], ["on_hold", "On hold"], ["lost", "Lost"], ["complete", "Complete"],
];

export default async function Projects({ searchParams }: { searchParams: Promise<{ stage?: string }> }) {
  await requireProfile();
  const { stage = "live" } = await searchParams;
  const db = await createClient();
  const [{ data: rows }, { data: counts }, { data: unmatched }, { data: diaryDays }, { data: unmatchedSites }, { data: allProjects }, { data: clients }, { data: last }] = await Promise.all([
    db.from("projects").select("id,display_name,stage,next_action,next_action_due,clients(name)").eq("stage", stage).order("name"),
    db.from("projects").select("stage"),
    db.from("unmatched_invoice_refs").select("reference,last_invoice,client,invoices").order("reference"),
    db.from("project_diary_days").select("*"),
    db.from("unmatched_diary_sites").select("site_as_typed,last_seen,days").is("resolved_project_id", null).eq("ignored", false).order("days", { ascending: false }),
    db.from("projects").select("id,display_name").order("name"),
    db.from("clients").select("id,name").order("name"),
    db.from("projects").select("number").order("number", { ascending: false }).limit(1),
  ]);
  // agreed days from each job's cost schedule (the hand-typed figure only when there isn't one)
  const planDays = new Map<string, number>();
  const ids = (rows ?? []).map((p) => p.id as string);
  for (let i = 0; i < ids.length; i += 10) {
    const { data: pm } = await db.from("project_planned_months").select("project_id,building,me").in("project_id", ids.slice(i, i + 10));
    for (const r of pm ?? []) planDays.set(r.project_id, (planDays.get(r.project_id) ?? 0) + Number(r.building) + Number(r.me));
  }
  const n = (s: string) => (counts ?? []).filter((c) => c.stage === s).length;
  const dd = new Map((diaryDays ?? []).map((d) => [d.project_id as string, d]));
  const month = new Date().toLocaleDateString("en-GB", { month: "long" });

  return (
    <>
      <div className="head"><div><h1>Projects</h1><p>From the Cost Proposals Register, the diary and Xero. Money columns are on the director’s view only. <Link href="/projects/dfe">DfE or other: quick check</Link> · <Link href="/projects/requests">Pricing requests</Link> · <Link href="/projects/lists">Email lists: replace someone who has left</Link></p></div></div>
      {!!unmatched?.length && (
        <details className="callout warn">
          <summary>{unmatched.length} Xero invoice reference{unmatched.length > 1 ? "s" : ""} don’t match a project</summary>
          <p className="small">These outstanding invoices aren’t linked to a project, so they’re left out of project totals. Usually the reference is spelt differently from the diary.</p>
          <table><tbody>
            {unmatched.map((u) => (
              <tr key={u.reference}><td><b>{u.reference}</b><span className="two">{u.client}</span></td>
                <td className="mono">{u.last_invoice}</td><td className="num">{u.invoices} invoice{u.invoices > 1 ? "s" : ""}</td></tr>
            ))}
          </tbody></table>
        </details>
      )}
      {!!unmatchedSites?.length && (
        <details className="callout warn">
          <summary>{unmatchedSites.length} diary site name{unmatchedSites.length > 1 ? "s" : ""} don’t match a project</summary>
          <p className="small">Visits under these names aren’t counted against any project. Usually a new spelling in the diary; the diary’s own check flags typos too.</p>
          <table><tbody>
            {unmatchedSites.map((u) => (
              <tr key={u.site_as_typed}><td><b>{u.site_as_typed}</b></td><td className="num">{u.days} days</td><td className="num">last {fd(u.last_seen)}</td>
                <td>
                  <form action={linkSite} className="row" style={{ flexWrap: "nowrap" }}>
                    <input type="hidden" name="site" value={u.site_as_typed} />
                    <select name="project_id" required defaultValue="" style={{ minWidth: 200 }}>
                      <option value="" disabled>Link to project…</option>
                      {(allProjects ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                    </select>
                    <button className="btn">Link</button>
                  </form>
                </td>
                <td><form action={ignoreSite.bind(null, u.site_as_typed)}><button className="btn" title="A one-off that isn't a project">Not a project</button></form></td></tr>
            ))}
          </tbody></table>
        </details>
      )}
      <details className="panel" id="new">
        <summary><b>+ New project</b> <span className="small muted">a phone enquiry, or a job to set up before any cost proposal</span></summary>
        <NewProjectForm clients={clients ?? []} nextNumber={(last?.[0]?.number ?? 1000) + 1} />
      </details>
      <nav className="row">
        {STAGES.map(([k, l]) => (
          <a key={k} href={`/projects?stage=${k}`} className={`btn ${k === stage ? "primary" : ""}`}>{l} <span className="small">{n(k)}</span></a>
        ))}
      </nav>
      <section className="panel">
        {!rows?.length ? <p className="empty">No projects at this stage yet.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Project</th><th>Client</th><th className="num">Agreed days</th><th className="num">Charged 2026</th><th className="num">{month}: planned / charged</th><th>Next action</th></tr></thead>
            <tbody>
              {rows.map((p) => {
                const days = Math.round((planDays.get(p.id) ?? 0) * 10) / 10 || null; // from the cost schedule only
                const d = dd.get(p.id);
                const used = Number(d?.charged_to_date ?? 0);
                return (
                  <tr key={p.id}>
                    <td><Link href={`/projects/${p.id}`}><b>{p.display_name}</b></Link>{d?.last_visit && <span className="two">last visit {fd(d.last_visit)}</span>}</td>
                    <td>{(p.clients as unknown as { name: string } | null)?.name}</td>
                    <td className="num">{days ?? "—"}</td>
                    <td className={`num ${days && used > days ? "neg" : ""}`}>{used || "—"}
                      {!!d?.charged_me && <span className="two">{d.charged_building ?? 0} bldg · {d.charged_me} M&amp;E</span>}
                      {days ? <span className="two">{used > days ? `${used - days} over` : `${days - used} left`}</span> : null}</td>
                    <td className="num">{d?.planned_this_month ?? 0} / {d?.charged_this_month ?? 0}</td>
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
