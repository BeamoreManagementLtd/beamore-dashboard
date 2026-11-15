import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { xeroClient, type XeroGet } from "@/lib/xero";

/**
 * Xero "Project" tracking category (decision 12): one option per live project, named as the dashboard names it
 * ("St Aidans 1073"), so draft invoices can be tagged and Xero reports can be run by project.
 * Options rotate to stay within Xero's 100: new wins and projects invoiced in the last 3 months (see setupProjectTracking).
 * Archived options stay on old invoices and in reports. Unused options of finished/lost/merged jobs are deleted
 * (Ronan approved both, 15 Nov 2026). Never renames.
 */
export const CATEGORY = "Project";
export const OPTION_LIMIT = 100;

type Option = { TrackingOptionID: string; Name: string; Status: string };
type Category = { TrackingCategoryID: string; Name: string; Status: string; Options: Option[] };

export async function projectCategory(get: XeroGet) {
  const r = await get<{ TrackingCategories: Category[] }>("TrackingCategories", { includeArchived: "true" });
  return r.TrackingCategories.find((c) => c.Name === CATEGORY && c.Status === "ACTIVE") ?? null;
}

/** Director's button: create the category if needed and add an option for every live project that hasn't one. */
export async function setupProjectTracking(admin: SupabaseClient) {
  const { data: run } = await admin.from("sync_runs").insert({ source: "xero-tracking" }).select("id").single();
  const finish = (ok: boolean, message: string) => admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const xero = await xeroClient(admin);
    let cat = await projectCategory(xero);
    if (!cat) {
      const r = await xero.put<{ TrackingCategories: Category[] }>("TrackingCategories", { Name: CATEGORY });
      cat = { ...r.TrackingCategories[0], Options: [] };
    }
    // Xero holds 100 active options, so they rotate (Ronan, 15 Nov 2026): wanted = new wins plus projects invoiced in
    // the last 3 months, most recent first. Others are archived (kept on old invoices); options never used on an invoice
    // can't be archived, so those are deleted when the project is finished, lost or merged away. A quiet project's
    // archived option is brought back when it's invoiced again.
    const since = new Date(Date.now() - 92 * 864e5).toISOString().slice(0, 10);
    const { data: projs } = await admin.from("projects").select("id,display_name,stage");
    const { data: recent } = await admin.from("invoices").select("project_id,issued").gte("issued", since).not("project_id", "is", null);
    const lastInv = new Map<string, string>();
    for (const i of recent ?? []) if ((lastInv.get(i.project_id) ?? "") < i.issued) lastInv.set(i.project_id, i.issued);
    const wantedList = (projs ?? [])
      .filter((p) => ["won_arranging", "won_preparing"].includes(p.stage) || (p.stage === "live" && lastInv.has(p.id)))
      .sort((a, b) => Number(b.stage !== "live") - Number(a.stage !== "live") || (lastInv.get(b.id) ?? "").localeCompare(lastInv.get(a.id) ?? ""))
      .slice(0, OPTION_LIMIT).map((p) => p.display_name.slice(0, 100));
    const wanted = new Set(wantedList.map((n) => n.toLowerCase()));
    const stageOf = new Map((projs ?? []).map((p) => [p.display_name.toLowerCase(), p.stage as string]));
    const finishedOrGone = (n: string) => !stageOf.has(n) || ["complete", "lost"].includes(stageOf.get(n)!);
    const opt = (o: Option) => `TrackingCategories/${cat!.TrackingCategoryID}/Options/${o.TrackingOptionID}`;
    const pause = () => new Promise((r) => setTimeout(r, 1100)); // Xero allows ~60 calls a minute
    let archived = 0, deleted = 0, restored = 0;
    for (const o of cat.Options.filter((x) => x.Status === "ACTIVE" && !wanted.has(x.Name.toLowerCase()))) {
      try {
        await xero.post(opt(o), { Name: o.Name, Status: "ARCHIVED" });
        o.Status = "ARCHIVED"; archived++;
      } catch (e) {
        if (!/not in use/i.test(String(e))) throw e;
        if (finishedOrGone(o.Name.toLowerCase())) { await xero.del(opt(o)); o.Status = "DELETED"; deleted++; }
      }
      await pause();
    }
    let active = cat.Options.filter((o) => o.Status === "ACTIVE").length;
    const have = new Set(cat.Options.filter((o) => o.Status === "ACTIVE").map((o) => o.Name.toLowerCase()));
    const adding: string[] = [];
    for (const name of wantedList) {
      if (have.has(name.toLowerCase()) || active >= OPTION_LIMIT) continue;
      const old = cat.Options.find((o) => o.Status === "ARCHIVED" && o.Name.toLowerCase() === name.toLowerCase());
      if (old) { await xero.post(opt(old), { Name: old.Name, Status: "ACTIVE" }); restored++; }
      else { await xero.put(`TrackingCategories/${cat.TrackingCategoryID}/Options`, { Name: name }); adding.push(name); }
      active++;
      await pause();
    }
    const left = wantedList.filter((n) => !have.has(n.toLowerCase())).length - adding.length - restored;
    const msg = `"${CATEGORY}" has ${active} active options: ${adding.length} added, ${restored} brought back, ${archived} archived (no invoice for 3 months, finished or lost), ${deleted} unused deleted` +
      (left > 0 ? `; ${left} wanted projects still waiting for a place` : "");
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = / 40[13] /.test(raw) ? `Xero refused (${raw.slice(0, 120)}): reconnect Xero on this page to allow tracking settings, then try again.` : raw;
    await finish(false, msg);
    return { ok: false, message: msg };
  }
}
