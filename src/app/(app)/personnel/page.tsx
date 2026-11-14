import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, today } from "@/lib/format";

export const dynamic = "force-dynamic";

const DBS: Record<string, [string, string]> = {
  verified: ["good", "Verified"], in_progress: ["neutral", "In progress"], action_needed: ["warn", "Action needed"], none: ["bad", "No check on file"],
};

export default async function Personnel() {
  await requireProfile();
  const db = await createClient();
  const t = today();
  const [{ data: clerks }, { data: absences }] = await Promise.all([
    db.from("clerks").select("id,name,active,clerk_compliance(dbs_status,dbs_recheck,chartership_body,chartership_grade,chartership_renewal,onboarding_complete)").eq("active", true).order("name"),
    db.from("absences").select("id,date_from,date_to,kind,status,clerks(name)").gte("date_to", t).order("date_from"),
  ]);

  return (
    <>
      <div className="head"><div><h1>Personnel</h1><p>Clerks, compliance and absences. DBS evidence files are visible to the director only.</p></div></div>
      <section className="panel">
        <h2>Upcoming absences</h2>
        {!absences?.length ? <p className="empty">None recorded.</p> : (
          <table><tbody>
            {absences.map((a) => (
              <tr key={a.id}><td>{(a.clerks as unknown as { name: string } | null)?.name}</td><td>{fd(a.date_from)}{a.date_to !== a.date_from ? ` – ${fd(a.date_to)}` : ""}</td><td>{a.kind}</td><td>{a.status}</td></tr>
            ))}
          </tbody></table>
        )}
      </section>
      <section className="panel">
        <h2>Clerks</h2>
        {!clerks?.length ? <p className="empty">No clerks yet. The diary sync adds them.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Clerk</th><th>DBS</th><th>Recheck</th><th>Chartership</th><th>Renewal</th><th>Onboarded</th></tr></thead>
            <tbody>
              {clerks.map((c) => {
                const raw = c.clerk_compliance as unknown;
                const cc = (Array.isArray(raw) ? raw[0] : raw) as { dbs_status?: string; dbs_recheck?: string; chartership_body?: string; chartership_grade?: string; chartership_renewal?: string; onboarding_complete?: boolean } | null;
                const [tone, label] = DBS[cc?.dbs_status ?? "none"];
                return (
                  <tr key={c.id}>
                    <td><b>{c.name}</b></td>
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
