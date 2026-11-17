import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fd, today } from "@/lib/format";
import { loadHolidays, workingDaysBetween, addWorkingDays } from "@/lib/reports/days";

/**
 * How punctual a clerk is with their reports (Ronan, 17 Nov 2026), on their page in the office dashboard only: each
 * report is due a set number of working days after the visit (report_settings.clerk_days, 2). Last three months.
 */
const addDays = (d: string, n: number) => new Date(Date.parse(`${d.slice(0, 10)}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const SOURCE: Record<string, string> = { report: "in the report", name: "file name", "name+diary": "file name and diary", diary: "diary", manual: "set by hand" };

export async function ReportTiming({ clerkId }: { clerkId: string }) {
  const db = await createClient();
  const t = today();
  const [{ data: settings }, { data }] = await Promise.all([
    db.from("report_settings").select("clerk_days").eq("id", 1).single(),
    db.from("reports").select("id,file_name,visit_date,visit_date_source,uploaded_at").eq("clerk_id", clerkId).not("visit_date", "is", null)
      .gte("uploaded_at", addDays(t, -92)).order("uploaded_at", { ascending: false }),
  ]);
  const clerkDays = settings?.clerk_days ?? 2;
  if (!data?.length) return null;
  const h = await loadHolidays();
  const rows = data.map((r) => {
    const up = r.uploaded_at.slice(0, 10);
    return { ...r, up, due: addWorkingDays(r.visit_date!, clerkDays, h), late: Math.max(0, workingDaysBetween(r.visit_date!, up, h) - clerkDays) };
  });
  const onTime = rows.filter((r) => !r.late).length, late = rows.filter((r) => r.late);
  const share = onTime / rows.length;
  return (
    <section className="panel">
      <h2>Reports in on time <span className="small muted">last 3 months · office only</span></h2>
      <p>
        <b className={share < 0.7 ? "neg" : share >= 0.9 ? "pos" : ""}>{Math.round(share * 100)}% on time</b> ({onTime} of {rows.length})
        {late.length ? <> · late ones average <b>{(late.reduce((s, r) => s + r.late, 0) / late.length).toFixed(1)} working days</b>, worst {Math.max(...late.map((r) => r.late))}</> : null}
        <span className="small muted"> · due {clerkDays} working day{clerkDays === 1 ? "" : "s"} after the visit</span>
      </p>
      <table className="small"><thead><tr><th>Report</th><th>Visit</th><th>Due</th><th>Uploaded</th><th className="num">Late</th></tr></thead>
        <tbody>{rows.slice(0, 12).map((r) => (
          <tr key={r.id}>
            <td><Link href={`/reports/${r.id}`}>{r.file_name.replace(/\.docx?$/i, "").slice(0, 70)}</Link></td>
            <td title={`Visit date from the ${SOURCE[r.visit_date_source ?? ""] ?? "report"}`}>{fd(r.visit_date!)}</td>
            <td>{fd(r.due)}</td>
            <td>{fd(r.up)}</td>
            <td className={`num ${r.late ? "neg" : "pos"}`}>{r.late ? `${r.late} day${r.late === 1 ? "" : "s"}` : "on time"}</td>
          </tr>
        ))}</tbody></table>
    </section>
  );
}
