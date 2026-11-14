import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, fdy, today } from "@/lib/format";
import { saveCompliance, startOnboarding, tickOnboarding, setActive, makeJoinLink, draftJoin } from "../actions";
import { joinLink } from "@/lib/join-link";
import { buildOnboarding } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

type Compliance = {
  dbs_level: string | null; dbs_status: string | null; dbs_checked: string | null; dbs_recheck: string | null; dbs_update_service: boolean | null;
  chartership_body: string | null; chartership_grade: string | null; chartership_number: string | null; chartership_renewal: string | null;
  ppe_notes: string | null; onboarding_complete: boolean; updated_at: string;
  address: string | null; emergency_contact: string | null; business_type: string | null; company_name: string | null; bank_details_received: string | null;
  pi_insurance_expiry: string | null; pl_insurance_expiry: string | null; cscs_number: string | null; cscs_expiry: string | null;
  right_to_work_checked: string | null; terms_signed: string | null; onboarding_started: string | null; onboarding_project_id: string | null;
  join_token: string | null; join_submitted_at: string | null; documents_folder_id: string | null;
};

export default async function Clerk({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ draft?: string }> }) {
  await requireProfile();
  const { id } = await params;
  const { draft } = await searchParams;
  const db = await createClient();
  const t = today();
  const monthStart = `${t.slice(0, 7)}-01`;
  const [{ data: clerk }, { data: comp }, { data: items }, { data: visits }, { data: absences }] = await Promise.all([
    db.from("clerks").select("id,name,email,phone,active").eq("id", id).maybeSingle(),
    db.from("clerk_compliance").select("*").eq("clerk_id", id).maybeSingle(),
    db.from("onboarding_items").select("id,item,done_on").eq("clerk_id", id).order("item"),
    db.from("diary_visits").select("visit_date,site_as_typed,kind,side,days,projects(display_name)").eq("clerk_id", id).gte("visit_date", monthStart).order("visit_date"),
    db.from("absences").select("date_from,date_to,kind").eq("clerk_id", id).gte("date_to", `${t.slice(0, 4)}-01-01`).order("date_from", { ascending: false }),
  ]);
  if (!clerk) notFound();
  const c = (comp ?? {}) as Partial<Compliance>;

  // this month by project
  const byProject = new Map<string, { planned: number; charged: number }>();
  for (const v of visits ?? []) {
    const name = (v.projects as unknown as { display_name: string } | null)?.display_name ?? v.site_as_typed;
    const p = byProject.get(name) ?? { planned: 0, charged: 0 };
    p[v.side as "planned" | "charged"] += Number(v.days);
    byProject.set(name, p);
  }
  const save = saveCompliance.bind(null, id);
  const { count: diaryRows } = await db.from("diary_visits").select("id", { count: "exact", head: true }).eq("clerk_id", id);
  const ticked = new Map((items ?? []).filter((i) => i.done_on).map((i) => [i.item, i.done_on as string]));
  const onb = c.onboarding_started ? buildOnboarding({ ...c, email: clerk.email, phone: clerk.phone }, ticked, (diaryRows ?? 0) > 0, t) : null;
  const { data: forProject } = c.onboarding_project_id ? await db.from("projects").select("id,display_name").eq("id", c.onboarding_project_id).maybeSingle() : { data: null };

  return (
    <>
      <div className="head">
        <div><h1>{clerk.name}</h1><p><Link href="/personnel">← Personnel</Link>{c.updated_at ? ` · record updated ${fdy(c.updated_at)}` : ""}</p></div>
        <form action={setActive.bind(null, id, !clerk.active)}><button className="btn">{clerk.active ? "Mark as no longer working with us" : "Mark as active again"}</button></form>
      </div>

      <form action={save} className="panel form">
        <h2>Contact</h2>
        <div className="row">
          <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" defaultValue={clerk.email ?? ""} /></div>
          <div className="field"><label htmlFor="phone">Phone</label><input id="phone" name="phone" defaultValue={clerk.phone ?? ""} /></div>
          <div className="field"><label htmlFor="ec">Emergency contact</label><input id="ec" name="emergency_contact" defaultValue={c.emergency_contact ?? ""} placeholder="Name and phone" /></div>
        </div>
        <div className="field"><label htmlFor="addr">Address</label><input id="addr" name="address" defaultValue={c.address ?? ""} /></div>
        <div className="row">
          <div className="field"><label htmlFor="bt">Works as</label>
            <select id="bt" name="business_type" defaultValue={c.business_type ?? ""}><option value="">—</option><option value="limited">Limited company</option><option value="sole_trader">Sole trader</option><option value="umbrella">Umbrella company</option></select></div>
          <div className="field"><label htmlFor="co">Company name</label><input id="co" name="company_name" defaultValue={c.company_name ?? ""} /></div>
          <div className="field"><label htmlFor="bank">Bank details received</label><input id="bank" name="bank_details_received" type="date" defaultValue={c.bank_details_received ?? ""} /></div>
        </div>
        <p className="small muted">Bank details themselves go in Xero, not here.</p>
        <h2>DBS</h2>
        <div className="row">
          <div className="field"><label htmlFor="dbs_level">Level</label>
            <select id="dbs_level" name="dbs_level" defaultValue={c.dbs_level ?? ""}><option value="">—</option><option>Basic</option><option>Standard</option><option>Enhanced</option></select></div>
          <div className="field"><label htmlFor="dbs_status">Status</label>
            <select id="dbs_status" name="dbs_status" defaultValue={c.dbs_status ?? ""}>
              <option value="">—</option><option value="verified">Verified</option><option value="in_progress">In progress</option>
              <option value="action_needed">Action needed</option><option value="none">No check on file</option>
            </select></div>
          <div className="field"><label htmlFor="dbs_checked">Checked</label><input id="dbs_checked" name="dbs_checked" type="date" defaultValue={c.dbs_checked ?? ""} /></div>
          <div className="field"><label htmlFor="dbs_recheck">Recheck due</label><input id="dbs_recheck" name="dbs_recheck" type="date" defaultValue={c.dbs_recheck ?? ""} /></div>
          <div className="field"><label htmlFor="dbs_us"><input id="dbs_us" name="dbs_update_service" type="checkbox" defaultChecked={!!c.dbs_update_service} style={{ width: "auto", marginRight: 6 }} />On the DBS Update Service</label></div>
        </div>
        <h2>Chartership</h2>
        <div className="row">
          <div className="field"><label htmlFor="cb">Body</label><input id="cb" name="chartership_body" list="bodies" defaultValue={c.chartership_body ?? ""} placeholder="ICWCI, CIOB, RICS…" />
            <datalist id="bodies"><option>ICWCI</option><option>CIOB</option><option>RICS</option><option>CIBSE</option><option>CABE</option></datalist></div>
          <div className="field"><label htmlFor="cg">Grade</label><input id="cg" name="chartership_grade" defaultValue={c.chartership_grade ?? ""} placeholder="e.g. MICWCI, FCIOB" /></div>
          <div className="field"><label htmlFor="cn">Membership number</label><input id="cn" name="chartership_number" defaultValue={c.chartership_number ?? ""} /></div>
          <div className="field"><label htmlFor="cr">Renewal due</label><input id="cr" name="chartership_renewal" type="date" defaultValue={c.chartership_renewal ?? ""} /></div>
        </div>
        <h2>Insurance, CSCS and right to work</h2>
        <div className="row">
          <div className="field"><label htmlFor="pi">Professional indemnity expires</label><input id="pi" name="pi_insurance_expiry" type="date" defaultValue={c.pi_insurance_expiry ?? ""} /></div>
          <div className="field"><label htmlFor="pl">Public liability expires</label><input id="pl" name="pl_insurance_expiry" type="date" defaultValue={c.pl_insurance_expiry ?? ""} /></div>
          <div className="field"><label htmlFor="cscsn">CSCS card number</label><input id="cscsn" name="cscs_number" defaultValue={c.cscs_number ?? ""} /></div>
          <div className="field"><label htmlFor="cscse">CSCS expires</label><input id="cscse" name="cscs_expiry" type="date" defaultValue={c.cscs_expiry ?? ""} /></div>
        </div>
        <div className="row">
          <div className="field"><label htmlFor="rtw">Right to work checked</label><input id="rtw" name="right_to_work_checked" type="date" defaultValue={c.right_to_work_checked ?? ""} /></div>
          <div className="field"><label htmlFor="terms">Terms signed</label><input id="terms" name="terms_signed" type="date" defaultValue={c.terms_signed ?? ""} /></div>
        </div>
        <h2>PPE</h2>
        <div className="field"><label htmlFor="ppe">Notes (sizes, what’s been issued)</label><textarea id="ppe" name="ppe_notes" rows={2} defaultValue={c.ppe_notes ?? ""} /></div>
        <div><button className="btn primary">Save</button> <span className="small muted">Insurance, CSCS, DBS and chartership renewals due within 30 days appear on Judy’s due list.</span></div>
      </form>

      <section className="panel wf">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2>Onboarding {onb && <span className="small muted">{onb.done} of {onb.total} done</span>}</h2>
          {!onb && <form action={startOnboarding.bind(null, id)}><button className="btn">Start onboarding</button></form>}
        </div>
        {!onb ? <p className="empty">Not being onboarded.{c.onboarding_complete ? " Marked as onboarded." : " Start it for anyone new to Beamore."}</p> : (
          <>
            <div className="wf-status">
              {onb.complete
                ? <span className="pill good">Ready for site</span>
                : <span className="pill warn">Not ready for site yet</span>}
              <p>{onb.complete ? `Onboarding complete.` : `Started ${fd(c.onboarding_started!)}${forProject ? ` for ${forProject.display_name}` : ""}. Next: ${onb.next?.title.toLowerCase()}.`}
                {forProject && <> <Link href={`/projects/${forProject.id}`}>Open project</Link></>}</p>
              <p className="small muted">Steps without a button tick themselves when the details above are filled in and saved.</p>
            </div>
            <div className="callout info">
              <b>New clerk form.</b>{" "}
              {c.join_submitted_at ? <>Filled in {fd(c.join_submitted_at)}. Their answers are in the record above{c.documents_folder_id ? <>; certificates are in <a href={`https://drive.google.com/drive/folders/${c.documents_folder_id}`} target="_blank" rel="noopener">their Drive folder ↗</a></> : ""}.</>
                : c.join_token ? <>Not filled in yet.</> : <>Send them a private link to fill in their own details, insurance, DBS, CSCS and PPE.</>}
              {c.join_token
                ? <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
                    <input readOnly value={joinLink(c.join_token)} aria-label="Questionnaire link" style={{ flex: 1, minWidth: 0 }} />
                    <form action={draftJoin.bind(null, id)}><button className="btn">Draft email with the link</button></form>
                  </div>
                : <form action={makeJoinLink.bind(null, id)} style={{ marginTop: 8 }}><button className="btn">Make their link</button></form>}
              {draft && <p className="small" style={{ marginTop: 6 }}>{draft}</p>}
            </div>
            {onb.groups.map((g) => (
              <div key={g.id}>
                <h3 className="small" style={{ margin: "10px 0 4px" }}>{g.id} · {g.title}</h3>
                <ol className="wf-steps">
                  {g.steps.map((st) => (
                    <li key={st.id} className={st.state}>
                      <span className="wf-title">{st.title}</span>
                      {st.note && <span className="wf-note">{st.note}</span>}
                      {st.tick && (
                        <form action={tickOnboarding.bind(null, id, st.tick, st.state !== "done")} className="wf-ctl">
                          {st.state === "done" ? <button className="linklike small">undo</button> : <button className="btn">Done</button>}
                        </form>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </>
        )}
      </section>

      <section className="panel">
        <h2>This month in the diary</h2>
        {!byProject.size ? <p className="empty">No visits this month.</p> : (
          <table>
            <thead><tr><th>Site</th><th className="num">Planned</th><th className="num">Charged</th></tr></thead>
            <tbody>{[...byProject].map(([n, p]) => <tr key={n}><td>{n}</td><td className="num">{p.planned || "—"}</td><td className="num">{p.charged || "—"}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Holidays this year</h2>
        {!absences?.length ? <p className="empty">None in the diary.</p> : (
          <table><tbody>{absences.map((a, i) => (
            <tr key={i}><td>{fd(a.date_from)}{a.date_to !== a.date_from ? ` – ${fd(a.date_to)}` : ""}</td><td>{a.kind}</td>
              <td className="num">{a.date_from > t ? "Upcoming" : a.date_to >= t ? "Now" : ""}</td></tr>
          ))}</tbody></table>
        )}
      </section>
    </>
  );
}
