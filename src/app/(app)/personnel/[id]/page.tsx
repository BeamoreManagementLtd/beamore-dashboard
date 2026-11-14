import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, fdy, today } from "@/lib/format";
import { saveCompliance, startOnboarding, toggleOnboardingItem, setActive } from "../actions";

export const dynamic = "force-dynamic";

type Compliance = {
  dbs_level: string | null; dbs_status: string | null; dbs_checked: string | null; dbs_recheck: string | null; dbs_update_service: boolean | null;
  chartership_body: string | null; chartership_grade: string | null; chartership_number: string | null; chartership_renewal: string | null;
  ppe_notes: string | null; onboarding_complete: boolean; updated_at: string;
};

export default async function Clerk({ params }: { params: Promise<{ id: string }> }) {
  await requireProfile();
  const { id } = await params;
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
  const done = (items ?? []).filter((i) => i.done_on).length;
  const save = saveCompliance.bind(null, id);

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
        </div>
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
        <h2>PPE</h2>
        <div className="field"><label htmlFor="ppe">Notes (sizes, what’s been issued)</label><textarea id="ppe" name="ppe_notes" rows={2} defaultValue={c.ppe_notes ?? ""} /></div>
        <div><button className="btn primary">Save</button> <span className="small muted">Renewals due within 30 days appear on Judy’s due list.</span></div>
      </form>

      <section className="panel">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2>Onboarding {items?.length ? <span className="small muted">{done} of {items.length} done</span> : null}</h2>
          {!items?.length && <form action={startOnboarding.bind(null, id)}><button className="btn">Start onboarding checklist</button></form>}
        </div>
        {!items?.length ? <p className="empty">No checklist yet.{c.onboarding_complete ? " Marked as onboarded." : ""}</p> : (
          <table><tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{i.item}</td>
                <td className="num">{i.done_on ? <span className="pill good">Done {fd(i.done_on)}</span> : <span className="muted">To do</span>}</td>
                <td className="num" style={{ width: 90 }}>
                  <form action={toggleOnboardingItem.bind(null, id, i.id, !i.done_on)}><button className="btn">{i.done_on ? "Undo" : "Done"}</button></form>
                </td>
              </tr>
            ))}
          </tbody></table>
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
