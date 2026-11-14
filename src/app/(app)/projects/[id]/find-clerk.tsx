import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { saveClerkNeeds, addCandidate, setCandidateStatus, appointCandidate, addApplicant } from "../actions";

const STATUS: Record<string, string> = {
  applied: "Applied", approached: "Approached", interested: "Interested", interviewed: "Interviewed", references: "References checked", declined: "Declined", appointed: "Appointed",
};
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);

/** Workflow 3, Find a clerk: shown on the project while it has no clerk (S3 "We need to find one"). */
export async function FindClerk({ db, project, today }: {
  db: SupabaseClient; today: string;
  project: { id: string; client_id: string | null; start_date: string | null; visits_per_week: number | null; clerk_needed: string | null; clerk_status?: string | null; clerk_me_status?: string | null; clerk_id?: string | null; clerk_me_id?: string | null };
}) {
  const roles = [!project.clerk_id && project.clerk_status === "finding" && "building", !project.clerk_me_id && project.clerk_me_status === "finding" && "me"].filter(Boolean) as ("building" | "me")[];
  const seeking = roles.length ? roles : (["building"] as const);
  const ROLE = { building: "Building", me: "M&E" } as const;
  const until = addDays(today, 28);
  const planned: { clerk_id: string; days: number }[] = [];
  for (let from = 0; ; from += 1000) { // the next four weeks of the diary's grey (planned) side
    const { data } = await db.from("diary_visits").select("clerk_id,days").eq("side", "planned").gte("visit_date", today).lte("visit_date", until).range(from, from + 999);
    planned.push(...((data ?? []) as { clerk_id: string; days: number }[]));
    if (!data || data.length < 1000) break;
  }
  const [{ data: clerks }, { data: candidates }, { data: clientProjects }, { data: activity }] = await Promise.all([
    db.from("clerks").select("id,name,active,clerk_compliance(onboarding_complete,dbs_status)").eq("active", true).order("name"),
    db.from("clerk_candidates").select("id,clerk_id,name,status,note,updated_at,application_id,role").eq("project_id", project.id).order("updated_at", { ascending: false }),
    project.client_id ? db.from("projects").select("id").eq("client_id", project.client_id) : Promise.resolve({ data: [] as { id: string }[] }),
    db.from("clerk_activity").select("clerk_id,last_visit"),
  ]);
  const { data: applicants } = await db.from("job_applications").select("id,name,role,location,source,received_at,thread_id,project_id")
    .eq("status", "new").or(`project_id.eq.${project.id},project_id.is.null`).gte("received_at", addDays(today, -60)).order("received_at", { ascending: false });
  const { data: appRows } = await db.from("clerk_candidates").select("application_id,job_applications(thread_id)").eq("project_id", project.id).not("application_id", "is", null);
  const appThread = new Map((appRows ?? []).map((a) => [a.application_id as string, (a.job_applications as unknown as { thread_id: string } | null)?.thread_id]));
  const { data: clientVisits } = (clientProjects ?? []).length
    ? await db.from("project_visit_summary").select("clerk_names").in("project_id", (clientProjects ?? []).map((p) => p.id))
    : { data: [] as { clerk_names: string[] | null }[] };
  const knowsClient = new Set((clientVisits ?? []).flatMap((v) => v.clerk_names ?? []));
  const busy = new Map<string, number>();
  for (const v of planned) busy.set(v.clerk_id, (busy.get(v.clerk_id) ?? 0) + Number(v.days));
  const recent = new Map((activity ?? []).map((a) => [a.clerk_id as string, a.last_visit as string]));
  const already = new Set((candidates ?? []).map((c) => c.clerk_id).filter(Boolean));
  const cutoff = addDays(today, -120);
  // C2: who could do it, least busy first; people who've worked for this client before come first among equals
  const shortlist = (clerks ?? [])
    .filter((c) => !already.has(c.id) && (recent.get(c.id) ?? "") >= cutoff)
    .map((c) => ({ ...c, free: 20 - (busy.get(c.id) ?? 0), knows: knowsClient.has(c.name) }))
    .sort((a, b) => b.free - a.free || Number(b.knows) - Number(a.knows))
    .slice(0, 8);
  const daysLeft = project.start_date ? Math.round((Date.parse(project.start_date) - Date.parse(today)) / 864e5) : null;

  return (
    <section className="panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2>Finding {seeking.map((x) => ROLE[x]).join(" and ")} clerk{seeking.length > 1 ? "s" : ""} of works</h2>
        {daysLeft != null && <span className={`pill ${daysLeft <= 21 ? "warn" : "neutral"}`}>{daysLeft < 0 ? `Started ${-daysLeft} days ago` : `Starts in ${daysLeft} days`}</span>}
      </div>

      <form action={saveClerkNeeds.bind(null, project.id)} className="row">
        <div className="field"><label htmlFor="cs">Start date</label><input id="cs" name="start_date" type="date" defaultValue={project.start_date ?? ""} /></div>
        <div className="field"><label htmlFor="cv">Visits a week</label><input id="cv" name="visits_per_week" type="number" step="0.5" min="0" defaultValue={project.visits_per_week ?? ""} /></div>
        <div className="field" style={{ flex: 2 }}><label htmlFor="cw">What we need (C1)</label><input id="cw" name="clerk_needed" placeholder="e.g. building CoW, DfE experience, M&E" defaultValue={project.clerk_needed ?? ""} /></div>
        <button className="btn">Save</button>
      </form>

      <h3 className="small" style={{ margin: "8px 0 0" }}>C2 · Who could do it</h3>
      <p className="small muted">Clerks who’ve worked in the last four months, least busy first (planned days in the diary over the next four weeks). ★ = has worked for this client.</p>
      <table><tbody>
        {shortlist.map((c) => (
          <tr key={c.id}>
            <td><Link href={`/personnel/${c.id}`}>{c.name}</Link>{c.knows ? " ★" : ""}</td>
            <td className="small muted">{busy.get(c.id) ?? 0} days planned</td>
            <td className="num">{seeking.map((role) => (
              <form key={role} action={addCandidate.bind(null, project.id, c.id, c.name)} style={{ display: "inline-block", marginLeft: 4 }}>
                <input type="hidden" name="role" value={role} /><button className="btn">Approach{seeking.length > 1 ? ` (${ROLE[role]})` : ""}</button>
              </form>))}</td>
          </tr>
        ))}
      </tbody></table>
      <form action={addCandidate.bind(null, project.id, null, "")} className="row">
        <div className="field"><label htmlFor="cn">Someone new to Beamore</label><input id="cn" name="name" placeholder="Name" required /></div>
        <div className="field"><label htmlFor="cnn">Note</label><input id="cnn" name="note" placeholder="Where from, phone…" /></div>
        <div className="field"><label htmlFor="cnr">For</label><select id="cnr" name="role" defaultValue={seeking[0]}><option value="building">Building</option><option value="me">M&amp;E</option></select></div>
        <button className="btn">Add</button>
      </form>

      {(applicants ?? []).length > 0 && <>
        <h3 className="small" style={{ margin: "8px 0 0" }}>Applied to us</h3>
        <p className="small muted">From Indeed and direct emails in the last 60 days{(applicants ?? []).some((a) => a.project_id) ? "; ones for this job first" : ""}.</p>
        <table><tbody>
          {[...(applicants ?? [])].sort((a, b) => Number(!!b.project_id) - Number(!!a.project_id)).map((a) => (
            <tr key={a.id}>
              <td>{a.name}<span className="two">{[a.role, a.location, a.source].filter(Boolean).join(" · ")}</span></td>
              <td className="small muted"><a href={`https://mail.google.com/mail/u/0/#all/${a.thread_id}`} target="_blank" rel="noopener">application ↗</a></td>
              <td className="num"><form action={addApplicant.bind(null, project.id, a.id)}><button className="btn">Add to shortlist</button></form></td>
            </tr>
          ))}
        </tbody></table>
      </>}

      <h3 className="small" style={{ margin: "8px 0 0" }}>C3 · Approached</h3>
      {!(candidates ?? []).length ? <p className="empty">Nobody yet.</p> : (
        <table><tbody>
          {(candidates ?? []).map((c) => (
            <tr key={c.id}>
              <td>{c.name}{!c.clerk_id && <span className="two">New to Beamore</span>}{c.note && <span className="two">{c.note}{c.application_id && appThread.get(c.application_id) && <> · <a href={`https://mail.google.com/mail/u/0/#all/${appThread.get(c.application_id)}`} target="_blank" rel="noopener">application ↗</a></>}</span>}</td>
              <td>
                <form action={setCandidateStatus.bind(null, project.id, c.id)} className="wf-inline">
                  <select name="role" defaultValue={c.role ?? "building"} aria-label={`Role for ${c.name}`}><option value="building">Building</option><option value="me">M&amp;E</option></select>
                  <select name="status" defaultValue={c.status} aria-label={`Status for ${c.name}`}>
                    {Object.entries(STATUS).filter(([k]) => k !== "appointed").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  <button className="btn">Save</button>
                </form>
              </td>
              <td className="num">{c.status !== "declined" && <form action={appointCandidate.bind(null, project.id, c.id)}><button className="btn primary">Appoint</button></form>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <p className="small muted">C4 · Appoint: someone who has worked with us becomes the project’s clerk straight away; someone new is added to Personnel and their onboarding starts.</p>
    </section>
  );
}
