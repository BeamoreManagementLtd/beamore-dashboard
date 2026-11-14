import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { siteKey } from "@/lib/site-key.mjs";
import { loadWorkbook } from "@/lib/sync/load-workbook.mjs";
import { parseCostSheet } from "@/lib/sync/proposal-parse.mjs";

/**
 * Planned days by month from each active project's latest cost sheet (daily, read only).
 * Finds the project's folder under My Drive/Business/Beamore Management/Cost Proposals/<Client>/ by name, picks the
 * most recently changed spreadsheet in it that has the month-by-month layout (cost schedules before attendance
 * plans), and stores its building and M&E days per month. Unchanged files are skipped.
 */
const FOLDER = "application/vnd.google-apps.folder";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const GSHEET = "application/vnd.google-apps.spreadsheet";
type F = { id: string; name: string; mimeType: string; modifiedTime: string };

export async function syncProposalPlans(admin: SupabaseClient, opts: { limit?: number } = {}) {
  const { data: run } = await admin.from("sync_runs").insert({ source: "proposals" }).select("id").single();
  const finish = (ok: boolean, message: string) => admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const g = await driveClient(admin);
    const list = async (q: string) => {
      const out: F[] = [];
      let pageToken: string | undefined;
      do {
        const r = await g.json<{ files: F[]; nextPageToken?: string }>("files", { q, fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
        out.push(...r.files); pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    };
    const child = async (parent: string, name: string) => (await list(`'${parent}' in parents and name = '${name}' and mimeType = '${FOLDER}' and trashed = false`))[0]?.id;
    let root: string | undefined = "root";
    for (const step of ["Business", "Beamore Management", "Cost Proposals"]) { root = await child(root!, step); if (!root) throw new Error(`No "${step}" folder on the way to Cost Proposals`); }

    // every project folder: Cost Proposals/<Client>/<Project>
    const clients = await list(`'${root}' in parents and mimeType = '${FOLDER}' and trashed = false`);
    const folders: (F & { client: string })[] = [];
    for (const c of clients) for (const f of await list(`'${c.id}' in parents and mimeType = '${FOLDER}' and trashed = false`)) folders.push({ ...f, client: c.name });

    const { data: projects } = await admin.from("projects").select("id,name,display_name,diary_aliases,proposal_folder_id,plan_file_id,plan_file_modified,clients(name)")
      .in("stage", ["won_arranging", "won_preparing", "live", "on_hold"]);
    let matched = 0, planned = 0, unchanged = 0, noSheet = 0;
    const missing: string[] = [];
    for (const p of (projects ?? []).slice(0, opts.limit ?? 1000)) {
      let folderId = p.proposal_folder_id as string | null;
      if (!folderId) {
        // same name, or one name contains the other; the project's client folder wins a tie
        const keys = [p.name, ...(p.diary_aliases ?? [])].map((n: string) => siteKey(n)).filter((k: string) => k.length >= 4);
        const client = siteKey((p.clients as unknown as { name: string } | null)?.name ?? "");
        // a partial name match (folder "Bristol" for "Airbus Bristol") only counts inside the project's own client's folder
        const sameClient = (f: { client: string }) => client.length >= 4 && siteKey(f.client).slice(0, 5) === client.slice(0, 5);
        const hits = folders.filter((f) => { const k = siteKey(f.name); return keys.some((x: string) => k === x || (k.length >= 5 && (k.includes(x) || x.includes(k)) && sameClient(f))); });
        const best = hits.sort((a, b) => Number(siteKey(b.client).includes(client.slice(0, 5))) - Number(siteKey(a.client).includes(client.slice(0, 5))) || Number(siteKey(b.name) === keys[0]) - Number(siteKey(a.name) === keys[0]))[0];
        if (!best) { missing.push(p.display_name); continue; }
        folderId = best.id;
        await admin.from("projects").update({ proposal_folder_id: folderId, proposal_folder: `${best.client}/${best.name}` }).eq("id", p.id);
      }
      matched++;
      // spreadsheets in the folder (and one level down), newest first; cost schedules before attendance plans
      const files = await list(`'${folderId}' in parents and (mimeType = '${XLSX}' or mimeType = '${GSHEET}') and trashed = false`);
      for (const sub of await list(`'${folderId}' in parents and mimeType = '${FOLDER}' and trashed = false`))
        files.push(...await list(`'${sub.id}' in parents and (mimeType = '${XLSX}' or mimeType = '${GSHEET}') and trashed = false`));
      const rank = (f: F) => (/attendance/i.test(f.name) ? 1 : 0);
      files.sort((a, b) => rank(a) - rank(b) || b.modifiedTime.localeCompare(a.modifiedTime));
      if (files[0] && files[0].id === p.plan_file_id && files[0].modifiedTime === p.plan_file_modified) { unchanged++; continue; }
      let done = false;
      for (const f of files.slice(0, 6)) {
        const buf = f.mimeType === GSHEET ? await g.exportXlsx(f.id) : await g.download(f.id);
        let rows: { month: string; building: number; me: number }[] = [];
        try { rows = parseCostSheet(await loadWorkbook(Buffer.from(buf))); } catch { continue; }
        if (!rows.length) continue;
        await admin.from("project_planned_months").delete().eq("project_id", p.id);
        await admin.from("project_planned_months").insert(rows.map((r) => ({ project_id: p.id, ...r })));
        await admin.from("projects").update({ plan_file: f.name, plan_file_id: f.id, plan_file_modified: f.modifiedTime }).eq("id", p.id);
        planned++; done = true;
        break;
      }
      if (!done) noSheet++;
    }
    const msg = `${matched} project folders found, ${planned} plans read, ${unchanged} unchanged, ${noSheet} with no month-by-month cost sheet${missing.length ? `; no folder found for ${missing.length} (e.g. ${missing.slice(0, 5).join(", ")})` : ""}`;
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await finish(false, m);
    return { ok: false, message: m };
  }
}
