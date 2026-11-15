import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { xeroClient, type XeroGet } from "@/lib/xero";

/**
 * Xero project tracking (decision 12), split in two (Ronan, 15 Nov 2026) because Xero allows 100 active options per
 * category and two categories: "Education projects" (DfE jobs, schools, colleges) and "Other projects" (everything
 * else; this is the original "Project" category, renamed, so past invoices keep their tags). One option per job, named
 * as the dashboard names it ("St Aidans 1073"). Clients never see tracking on invoices.
 *
 * Options rotate within each category's 100: jobs being set up or starting within a month, plus live jobs invoiced in
 * the last 3 months or on site in the last 2, most recent first. Others are archived (they stay on old invoices and in
 * reports); options never used on an invoice can't be archived, so they're deleted when the job is finished, lost,
 * merged away, or belongs in the other category. An archived option comes back when its job is invoiced again.
 */
export const EDUCATION = "Education projects";
export const OTHER = "Other projects";
const LEGACY = "Project"; // the original single category, renamed to OTHER on the first run
export const TRACKING_NAMES = [EDUCATION, OTHER, LEGACY];
export const OPTION_LIMIT = 100;

type Option = { TrackingOptionID: string; Name: string; Status: string };
type Category = { TrackingCategoryID: string; Name: string; Status: string; Options: Option[] };

const SCHOOLISH = /\b(school|academy|college|primary|high|grammar|sixth form|infant|junior|SEN|PRU)\b/i;
/** Education = DfE, or a school/college job (folder type or name). */
export function isEducation(p: { is_dfe?: boolean | null; folder_kind?: string | null; display_name?: string; name?: string }) {
  return !!p.is_dfe || p.folder_kind === "dfe" || p.folder_kind === "school" || SCHOOLISH.test(p.display_name ?? p.name ?? "");
}

/** Both categories as they are in Xero now (Other may still be called "Project" before the first run). */
export async function projectCategories(get: XeroGet) {
  const r = await get<{ TrackingCategories: Category[] }>("TrackingCategories", { includeArchived: "true" });
  const active = r.TrackingCategories.filter((c) => c.Status === "ACTIVE");
  return {
    education: active.find((c) => c.Name === EDUCATION) ?? null,
    other: active.find((c) => c.Name === OTHER) ?? active.find((c) => c.Name === LEGACY) ?? null,
  };
}

/** Sets up both categories and rotates their options. Runs every morning and from the Finance page. */
export async function setupProjectTracking(admin: SupabaseClient) {
  const { data: run } = await admin.from("sync_runs").insert({ source: "xero-tracking" }).select("id").single();
  const finish = (ok: boolean, message: string) => admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const xero = await xeroClient(admin);
    const pause = () => new Promise((r) => setTimeout(r, 1100)); // Xero allows ~60 calls a minute
    let { education, other } = await projectCategories(xero);
    if (other && other.Name === LEGACY) { // first run after the split: rename, keeping every past tag
      await xero.post(`TrackingCategories/${other.TrackingCategoryID}`, { Name: OTHER });
      other.Name = OTHER;
      await pause();
    }
    if (!other) { const r = await xero.put<{ TrackingCategories: Category[] }>("TrackingCategories", { Name: OTHER }); other = { ...r.TrackingCategories[0], Options: [] }; await pause(); }
    if (!education) { const r = await xero.put<{ TrackingCategories: Category[] }>("TrackingCategories", { Name: EDUCATION }); education = { ...r.TrackingCategories[0], Options: [] }; await pause(); }

    // which jobs need an option now, most recent activity first
    const since = new Date(Date.now() - 92 * 864e5).toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10), visitSince = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
    const [{ data: projs }, { data: vis }, { data: recent }] = await Promise.all([
      admin.from("projects").select("id,display_name,stage,start_date,stage_changed_at,is_dfe,folder_kind"),
      admin.from("project_visit_summary").select("project_id,last_visit,charged_visits"),
      admin.from("invoices").select("project_id,issued").gte("issued", since).not("project_id", "is", null),
    ]);
    const onSite = new Map((vis ?? []).filter((v) => v.charged_visits > 0 && v.last_visit >= visitSince).map((v) => [v.project_id as string, v.last_visit as string]));
    const lastInv = new Map<string, string>();
    for (const i of recent ?? []) if ((lastInv.get(i.project_id) ?? "") < i.issued) lastInv.set(i.project_id, i.issued);
    const wantedAll = (projs ?? [])
      .filter((p) => (p.stage === "live" && (lastInv.has(p.id) || onSite.has(p.id) || (p.stage_changed_at ?? "") >= visitSince))
        || p.stage === "won_arranging" || (p.stage === "won_preparing" && !!p.start_date && p.start_date <= soon))
      .sort((a, b) => (lastInv.get(b.id) ?? onSite.get(b.id) ?? "9").localeCompare(lastInv.get(a.id) ?? onSite.get(a.id) ?? "9"));
    const byName = new Map((projs ?? []).map((p) => [p.display_name.toLowerCase(), p]));
    const gone = (n: string) => { const p = byName.get(n); return !p || ["complete", "lost"].includes(p.stage); };

    const report: string[] = [];
    let waiting = 0;
    for (const [cat, edu] of [[education, true], [other, false]] as const) {
      const wantedList = wantedAll.filter((p) => isEducation(p) === edu).slice(0, OPTION_LIMIT).map((p) => p.display_name.slice(0, 100));
      const wanted = new Set(wantedList.map((n) => n.toLowerCase()));
      const opt = (o: Option) => `TrackingCategories/${cat.TrackingCategoryID}/Options/${o.TrackingOptionID}`;
      let archived = 0, deleted = 0, restored = 0, added = 0;
      for (const o of cat.Options.filter((x) => x.Status === "ACTIVE" && !wanted.has(x.Name.toLowerCase()))) {
        const n = o.Name.toLowerCase();
        const p = byName.get(n);
        const wrongCategory = !!p && isEducation(p) !== edu;
        try {
          await xero.post(opt(o), { Name: o.Name, Status: "ARCHIVED" });
          o.Status = "ARCHIVED"; archived++;
        } catch (e) {
          if (!/not in use/i.test(String(e))) throw e;
          if (gone(n) || wrongCategory) { await xero.del(opt(o)); o.Status = "DELETED"; deleted++; }
        }
        await pause();
      }
      let active = cat.Options.filter((o) => o.Status === "ACTIVE").length;
      const have = new Set(cat.Options.filter((o) => o.Status === "ACTIVE").map((o) => o.Name.toLowerCase()));
      for (const name of wantedList) {
        if (have.has(name.toLowerCase())) continue;
        if (active >= OPTION_LIMIT) { waiting++; continue; }
        const old = cat.Options.find((o) => o.Status === "ARCHIVED" && o.Name.toLowerCase() === name.toLowerCase());
        if (old) { await xero.post(opt(old), { Name: old.Name, Status: "ACTIVE" }); restored++; }
        else { await xero.put(`TrackingCategories/${cat.TrackingCategoryID}/Options`, { Name: name }); added++; }
        active++;
        await pause();
      }
      report.push(`"${cat.Name}": ${active} active (${added} added, ${restored} brought back, ${archived} archived, ${deleted} unused deleted)`);
    }
    const msg = report.join("; ") + (waiting ? `; ${waiting} jobs waiting for a place` : "");
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = / 40[13] /.test(raw) ? `Xero refused (${raw.slice(0, 120)}): reconnect Xero on this page to allow tracking settings, then try again.` : raw;
    await finish(false, msg);
    return { ok: false, message: msg };
  }
}
