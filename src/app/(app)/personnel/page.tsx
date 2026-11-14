import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, today } from "@/lib/format";
import { addAbsence, cancelAbsence, addNewClerk } from "./actions";
import { dismissApplication } from "../projects/actions";

export const dynamic = "force-dynamic";

const DBS: Record<string, [string, string]> = {
  verified: ["good", "Verified"], in_progress: ["neutral", "In progress"], action_needed: ["warn", "Action needed"], none: ["bad", "No check on file"],
};

export default async function Personnel({ searchParams }: { searchParams: Promise<{ show?: string; project?: string; name?: string; role?: string }> }) {
  await requireProfile();
  const { show, project, name, role } = await searchParams;
  const db = await createClient();
  const t = today();
  const cutoff = new Date(Date.parse(t + "T00:00:00Z") - 60 * 86400000).toISOString().slice(0, 10);
  const [{ data: clerks }, { data: absences }, { data: monthDays }, { data: activity }] = await Promise.all([
    db.from("clerks").select("id,name,active,clerk_compliance(dbs_status,dbs_recheck,chartership_body,chartership_grade,chartership_renewal,onboarding_complete,onboarding_started)").order("name"),
    db.from("absences").select("id,date_from,date_to,part_day,kind,status,source,synced_to_diary_at,clerk_id,clerks(name)").gte("date_to", t).neq("status", "cancelled").order("date_from"),
    db.from("clerk_month_days").select("*"),
    db.from("clerk_activity").select("*"),
  ]);
  const md = new Map((monthDays ?? []).map((m) => [m.clerk_id as string, m]));
  const last = new Map((activity ?? []).map((a) => [a.clerk_id as string, a.last_visit as string]));
  const working = (c: { id: string; active: boolean }) => c.active && (last.get(c.id) ?? "") >= cutoff;
  const all = clerks ?? [];
  const shown = show === "all" ? all : all.filter(working);
  const month = new Date().toLocaleDateString("en-GB", { month: "long" });
  const comp = (raw: unknown) => (Array.isArray(raw) ? raw[0] : raw) as
    { dbs_status?: string; dbs_recheck?: string; chartership_body?: string; chartership_grade?: string; chartership_renewal?: string; onboarding_complete?: boolean; onboarding_started?: string } | null;
  const onboarding = all.filter((c) => comp(c.clerk_compliance)?.onboarding_started && !comp(c.clerk_compliance)?.onboarding_complete);
  const { data: applicants } = await db.from("job_applications").select("id,name,role,location,source,received_at,thread_id,projects(id,display_name)").eq("status", "new").order("received_at", { ascending: false }).limit(30);
  const { data: wonProjects } = await db.from("projects").select("id,display_name").in("stage", ["won_arranging", "won_preparing", "live"]).order("name");
  const missingDbs = all.filter(working).filter((c) => !comp(c.clerk_compliance)?.dbs_status).length;
  // a diary holiday that a dashboard entry already covers is shown once (as the dashboard entry)
  const abs = absences ?? [];
  const shownAbsences = abs.filter((a) => a.source !== "diary" || !abs.some((d) =>
    d.source === "dashboard" && d.clerk_id === a.clerk_id && d.date_from <= a.date_from && d.date_to >= a.date_to));

  return (
    <>
      <div className="head">
        <div><h1>Personnel</h1><p>Clerks, compliance and holidays. Click a name to update their DBS, chartership, PPE and onboarding.</p></div>
      </div>
      <section className="panel" id="new">
        <h2>New clerks</h2>
        {onboarding.length > 0 && (
          <p className="small">Being onboarded: {onboarding.map((c, i) => <span key={c.id}>{i ? ", " : ""}<Link href={`/personnel/${c.id}`}>{c.name}</Link></span>)}. They’re not ready for site until every step is green.</p>
        )}
        {(applicants ?? []).length > 0 && (
          <details>
            <summary className="small">{(applicants ?? []).length} people have applied to work for us (Indeed and email)</summary>
            <table><tbody>
              {(applicants ?? []).map((a) => {
                const job = a.projects as unknown as { id: string; display_name: string } | null;
                return (
                  <tr key={a.id}>
                    <td>{a.name}<span className="two">{[a.role, a.location, a.source, a.received_at && fd(a.received_at.slice(0, 10))].filter(Boolean).join(" · ")}</span></td>
                    <td className="small">{job ? <Link href={`/projects/${job.id}`}>{job.display_name}</Link> : <span className="muted">no job named</span>}</td>
                    <td className="small"><a href={`https://mail.google.com/mail/u/0/#all/${a.thread_id}`} target="_blank" rel="noopener">application ↗</a></td>
                    <td className="num"><form action={dismissApplication.bind(null, a.id)}><button className="linklike small">dismiss</button></form></td>
                  </tr>
                );
              })}
            </tbody></table>
            <p className="small muted">To shortlist someone for a job, open the job and use Find a clerk.</p>
          </details>
        )}
        <form action={addNewClerk} className="row">
          <div className="field"><label htmlFor="nn">Name (as it will appear in the diary)</label><input id="nn" name="name" required defaultValue={name ?? ""} /></div>
          <div className="field"><label htmlFor="ne">Email</label><input id="ne" name="email" type="email" /></div>
          <div className="field"><label htmlFor="np">Phone</label><input id="np" name="phone" /></div>
          <div className="field"><label htmlFor="nj">Appointed for</label>
            <select id="nj" name="project_id" defaultValue={project ?? ""}>
              <option value="">No particular project</option>
              {(wonProjects ?? []).map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
            </select></div>
          <div className="field"><label htmlFor="nr">As</label>
            <select id="nr" name="role" defaultValue={role === "me" ? "me" : "building"}><option value="building">Building clerk</option><option value="me">M&amp;E clerk</option></select></div>
          <button className="btn primary">Add and start onboarding</button>
        </form>
      </section>
      {missingDbs > 0 && <p className="callout warn">{missingDbs} clerk{missingDbs > 1 ? "s" : ""} working with us {missingDbs > 1 ? "have" : "has"} no DBS record in the dashboard yet.</p>}
      <section className="panel">
        <h2>Holidays coming up</h2>
        <form action={addAbsence} className="row" style={{ marginBottom: 12 }}>
          <div className="field"><label htmlFor="hc">Clerk</label>
            <select id="hc" name="clerk_id" required defaultValue="">
              <option value="" disabled>Choose…</option>
              {all.filter(working).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div className="field"><label htmlFor="hf">From</label><input id="hf" name="date_from" type="date" required /></div>
          <div className="field"><label htmlFor="ht">To</label><input id="ht" name="date_to" type="date" /></div>
          <div className="field"><label htmlFor="hp">Part day</label>
            <select id="hp" name="part_day" defaultValue=""><option value="">Whole day(s)</option><option value="am">Morning only</option><option value="pm">Afternoon only</option></select></div>
          <div className="field"><label htmlFor="hk">Type</label>
            <select id="hk" name="kind" defaultValue="Holiday"><option>Holiday</option><option>Sick</option><option>Training</option><option>Other</option></select></div>
          <div className="field"><label htmlFor="hv"><input id="hv" name="provisional" type="checkbox" style={{ width: "auto", marginRight: 6 }} />Not confirmed yet</label></div>
          <button className="btn primary">Add holiday</button>
        </form>
        {!shownAbsences.length ? <p className="empty">None coming up.</p> : (
          <table><tbody>
            {shownAbsences.map((a) => (
              <tr key={a.id}>
                <td><Link href={`/personnel/${a.clerk_id}`}>{(a.clerks as unknown as { name: string } | null)?.name}</Link></td>
                <td>{fd(a.date_from)}{a.date_to !== a.date_from ? ` – ${fd(a.date_to)}` : ""}{a.part_day ? ` (${a.part_day})` : ""}</td>
                <td>{a.kind}{a.status === "provisional" ? <span className="two">not confirmed</span> : null}</td>
                <td>{a.source === "diary" ? <span className="muted small">from the diary</span>
                  : a.synced_to_diary_at ? <span className="pill good">In the diary</span> : <span className="pill warn">Add to the diary</span>}</td>
                <td className="num">{a.date_from <= t ? "Now" : ""}</td>
                <td className="num">{a.source === "dashboard" && <form action={cancelAbsence.bind(null, a.id)}><button className="btn">Cancel</button></form>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </section>
      <nav className="row">
        <Link href="/personnel" className={`btn ${show !== "all" ? "primary" : ""}`}>Working with us <span className="small">{all.filter(working).length}</span></Link>
        <Link href="/personnel?show=all" className={`btn ${show === "all" ? "primary" : ""}`}>Everyone <span className="small">{all.length}</span></Link>
      </nav>
      <section className="panel">
        {!shown.length ? <p className="empty">No clerks yet. The diary sync adds them.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Clerk</th><th className="num">{month}: planned / charged</th><th>DBS</th><th>Recheck</th><th>Chartership</th><th>Renewal</th><th>Onboarded</th></tr></thead>
            <tbody>
              {shown.map((c) => {
                const cc = comp(c.clerk_compliance);
                const [tone, label] = DBS[cc?.dbs_status ?? "none"];
                const m = md.get(c.id);
                return (
                  <tr key={c.id} className={working(c) ? "" : "muted"}>
                    <td><Link href={`/personnel/${c.id}`}><b>{c.name}</b></Link><span className="two">{last.get(c.id) ? `last in diary ${fd(last.get(c.id))}` : "not in the diary"}</span></td>
                    <td className="num">{m?.planned ?? 0} / {m?.charged ?? 0}{!!m?.sites && <span className="two">{m.sites} sites</span>}</td>
                    <td><span className={`pill ${tone}`}>{label}</span></td>
                    <td className={cc?.dbs_recheck && cc.dbs_recheck < t ? "neg" : ""}>{fd(cc?.dbs_recheck)}</td>
                    <td>{[cc?.chartership_body, cc?.chartership_grade].filter(Boolean).join(" ") || <span className="muted">—</span>}</td>
                    <td className={cc?.chartership_renewal && cc.chartership_renewal < t ? "neg" : ""}>{fd(cc?.chartership_renewal)}</td>
                    <td>{cc?.onboarding_complete ? "Yes" : <span className="muted">No</span>}</td>
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
