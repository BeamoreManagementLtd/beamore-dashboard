/** Writes parsed report files into the database (service-role client). Plain JavaScript, shared with local scripts. */
import { siteKey, clerkKey } from "../site-key.mjs";

const must = ({ data, error }, what) => { if (error) throw new Error(`${what}: ${error.message}`); return data; };

async function lookups(admin) {
  const [projects, clerks] = await Promise.all([
    must(await admin.from("projects").select("id,name,diary_aliases"), "projects"),
    must(await admin.from("clerks").select("id,name,name_key"), "clerks"),
  ]);
  const byKey = new Map();
  for (const p of projects) if (siteKey(p.name)) byKey.set(siteKey(p.name), p.id);
  for (const p of projects) for (const a of p.diary_aliases) if (siteKey(a)) byKey.set(siteKey(a), p.id);
  const keys = [...byKey.keys()];
  // "Blackburn College - M&E" → Blackburn College; also a shortened name that points to only one project
  const projectFor = (name) => {
    const k = siteKey(String(name ?? "").split(/\s+[-–]\s+/)[0]);
    if (!k) return null;
    if (byKey.has(k)) return byKey.get(k);
    if (k.length < 5) return null;
    const hits = new Set(keys.filter((x) => x.length >= 5 && (x.startsWith(k) || k.startsWith(x))).map((x) => byKey.get(x)));
    return hits.size === 1 ? [...hits][0] : null;
  };
  const clerkBy = new Map(clerks.map((c) => [c.name_key ?? clerkKey(c.name), c.id]));
  // fall back to the surname when only one clerk has it ("A M Marris" → Andrew Marris)
  const bySurname = new Map();
  for (const c of clerks) { const s = clerkKey(c.name).split(" ").at(-1); bySurname.set(s, bySurname.has(s) ? null : c.id); }
  const clerkFor = (n) => {
    const k = clerkKey(n);
    return clerkBy.get(k) ?? (k.includes(" ") ? bySurname.get(k.split(" ").at(-1)) ?? null : null);
  };
  return { projectFor, clerkFor };
}

/** Replaces the queue with the latest Ready To Check scan. */
export async function writeQueue(admin, rows, scannedAt) {
  const { projectFor } = await lookups(admin);
  must(await admin.from("report_queue").delete().neq("report_name", ""), "clear queue");
  if (rows.length)
    must(await admin.from("report_queue").insert(rows.map((r) => ({
      project_name: r.project_name, project_id: projectFor(r.project_name), report_name: r.report_name, folder: r.folder,
      report_date: r.report_date, due: r.due, checker: r.checker, scanned_at: scannedAt,
    }))), "queue");
  const late = rows.filter((r) => r.due && r.due < new Date().toISOString().slice(0, 10)).length;
  return `${rows.length} reports waiting (${late} past due, ${rows.filter((r) => r.checker === "Unknown").length} with no checker)`;
}

/** Adds or updates every report in the turnaround log (keyed on the Word file's Drive ID). */
export async function writeLog(admin, rows) {
  const { projectFor, clerkFor } = await lookups(admin);
  const seen = new Set();
  const data = rows.filter((r) => !seen.has(r.drive_file_id) && seen.add(r.drive_file_id)).map((r) => ({
    ...r, project_id: projectFor(r.project_name), clerk_id: clerkFor(r.clerk_name),
  }));
  for (let i = 0; i < data.length; i += 500)
    must(await admin.from("report_log").upsert(data.slice(i, i + 500), { onConflict: "drive_file_id" }), "report log");
  return `${data.length} reports in the turnaround log (${data.filter((r) => !r.clerk_id).length} clerk names not matched)`;
}
