import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { xeroClient, type XeroGet } from "@/lib/xero";

/**
 * Xero "Project" tracking category (decision 12): one option per live project, named as the dashboard names it
 * ("St Aidans 1073"), so draft invoices can be tagged and Xero reports can be run by project.
 * Adds an option for every live project. To stay under Xero's ~100 options it archives the options of finished and lost
 * projects (Ronan approved this, 15 Nov 2026). Archived options stay on old invoices and in reports. Never deletes or renames.
 */
export const CATEGORY = "Project";
export const OPTION_LIMIT = 100;

type Option = { TrackingOptionID: string; Name: string; Status: string };
type Category = { TrackingCategoryID: string; Name: string; Status: string; Options: Option[] };

export async function projectCategory(get: XeroGet) {
  const r = await get<{ TrackingCategories: Category[] }>("TrackingCategories", {});
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
    // finished and lost projects (and merged-away names) don't need an active option
    const { data: done } = await admin.from("projects").select("display_name").in("stage", ["complete", "lost"]);
    const { data: allNow } = await admin.from("projects").select("display_name");
    const doneNames = new Set((done ?? []).map((p) => p.display_name.toLowerCase()));
    const known = new Set((allNow ?? []).map((p) => p.display_name.toLowerCase()));
    const RETIRED = new Set(["higham park 1312"]); // merged into Highams Park 1022
    let archived = 0;
    for (const o of cat.Options.filter((x) => x.Status === "ACTIVE")) {
      const n = o.Name.toLowerCase();
      if (!doneNames.has(n) && !(RETIRED.has(n) && !known.has(n))) continue;
      await xero.post(`TrackingCategories/${cat.TrackingCategoryID}/Options/${o.TrackingOptionID}`, { Name: o.Name, Status: "ARCHIVED" });
      o.Status = "ARCHIVED";
      archived++;
      await new Promise((r) => setTimeout(r, 1100));
    }
    const have = new Set(cat.Options.filter((o) => o.Status === "ACTIVE").map((o) => o.Name.toLowerCase()));
    const { data: live } = await admin.from("projects").select("display_name").in("stage", ["live", "won_arranging", "won_preparing"]).order("name");
    const missing = (live ?? []).map((p) => p.display_name.slice(0, 100)).filter((n) => !have.has(n.toLowerCase()));
    const room = Math.max(0, OPTION_LIMIT - have.size);
    const adding = missing.slice(0, room);
    for (const name of adding) { // Xero allows ~60 calls a minute
      await xero.put(`TrackingCategories/${cat.TrackingCategoryID}/Options`, { Name: name });
      await new Promise((r) => setTimeout(r, 1100));
    }
    const total = have.size + adding.length;
    const left = missing.length - adding.length;
    const msg = `"${CATEGORY}" category has ${total} active options (${adding.length} added, ${archived} finished or lost archived)` +
      (left ? `; ${left} live projects not added because Xero suggests at most ${OPTION_LIMIT}: archive finished projects' options in Xero (Settings → Tracking categories)` : "");
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = / 40[13] /.test(raw) ? `Xero refused (${raw.slice(0, 120)}): reconnect Xero on this page to allow tracking settings, then try again.` : raw;
    await finish(false, msg);
    return { ok: false, message: msg };
  }
}
