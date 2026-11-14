import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd, today } from "@/lib/format";

export const dynamic = "force-dynamic";

const DBS: Record<string, [string, string]> = {
  verified: ["good", "Verified"], in_progress: ["neutral", "In progress"], action_needed: ["warn", "Action needed"], none: ["bad", "No check on file"],
};

export default async function Personnel({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  await requireProfile();
  const { show } = await searchParams;
  const db = await createClient();
  const t = today();
  const cutoff = new Date(Date.parse(t + "T00:00:00Z") - 60 * 86400000).toISOString().slice(0, 10);
  const [{ data: clerks }, { data: absences }, { data: monthDays }, { data: activity }] = await Promise.all([
    db.from("clerks").select("id,name,active,clerk_compliance(dbs_status,dbs_recheck,chartership_body,chartership_grade,chartership_renewal,onboarding_complete)").order("name"),
    db.from("absences").select("id,date_from,date_to,kind,status,clerk_id,clerks(name)").gte("date_to", t).order("date_from"),
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
    { dbs_status?: string; dbs_recheck?: string; chartership_body?: string; chartership_grade?: string; chartership_renewal?: string; onboarding_complete?: boolean } | null;
  const missingDbs = all.filter(working).filter((c) => !comp(c.clerk_compliance)?.dbs_status).length;

  return (
    <>
      <div className="head">
        <div><h1>Personnel</h1><p>Clerks, compliance and holidays. Click a name to update their DBS, chartership, PPE and onboarding.</p></div>
      </div>
      {missingDbs > 0 && <p className="callout warn">{missingDbs} clerk{missingDbs > 1 ? "s" : ""} working with us {missingDbs > 1 ? "have" : "has"} no DBS record in the dashboard yet.</p>}
      <section className="panel">
        <h2>Holidays coming up</h2>
        {!absences?.length ? <p className="empty">None in the diary.</p> : (
          <table><tbody>
            {absences.map((a) => (
              <tr key={a.id}><td><Link href={`/personnel/${a.clerk_id}`}>{(a.clerks as unknown as { name: string } | null)?.name}</Link></td>
                <td>{fd(a.date_from)}{a.date_to !== a.date_from ? ` – ${fd(a.date_to)}` : ""}</td><td>{a.kind}</td><td className="num">{a.date_from <= t ? "Now" : ""}</td></tr>
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
