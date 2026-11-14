import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { siteKey } from "@/lib/site-key.mjs";
import { readDiaryFront } from "@/lib/sync/diary-front.mjs";

/**
 * Project details from the front page of the newest CoW diary in each active project's folder
 * (My Drive/Work/Schools or Work/Others): DfE project director, manager and number, TA, principal contractor
 * and their PM and project number. They tick the matching checklist items with the actual names. Also links each
 * project to its existing folder. Daily, read only (except the dashboard's own records).
 */
const FOLDER = "application/vnd.google-apps.folder";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
type F = { id: string; name: string; mimeType: string; modifiedTime: string };
const unknown = (v?: string) => !v || /^(tbc|tba|n\/?a|not known|unknown|-|none)\.?$/i.test(v.trim());

export async function syncProjectDetails(admin: SupabaseClient) {
  const { data: run } = await admin.from("sync_runs").insert({ source: "details" }).select("id").single();
  const finish = (ok: boolean, message: string) => admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const g = await driveClient(admin);
    const list = async (q: string) => {
      const out: F[] = []; let pageToken: string | undefined;
      do {
        const r = await g.json<{ files: F[]; nextPageToken?: string }>("files", { q, fields: "nextPageToken,files(id,name,mimeType,modifiedTime)", pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
        out.push(...r.files); pageToken = r.nextPageToken;
      } while (pageToken);
      return out;
    };
    const work = (await list(`name = 'Work' and 'root' in parents and mimeType = '${FOLDER}' and trashed = false`))[0];
    if (!work) throw new Error('No "Work" folder at the top of My Drive');
    const folders: F[] = [];
    for (const top of await list(`'${work.id}' in parents and (name = 'Schools' or name = 'Others') and mimeType = '${FOLDER}' and trashed = false`))
      folders.push(...await list(`'${top.id}' in parents and mimeType = '${FOLDER}' and trashed = false`));

    const { data: projects } = await admin.from("projects").select("id,name,display_name,diary_aliases,drive_folder_id,details")
      .in("stage", ["won_arranging", "won_preparing", "live", "on_hold"]);
    const { data: infoRows } = await admin.from("project_info").select("id,project_id,item,received_on,note").in("project_id", (projects ?? []).map((p) => p.id));
    let linked = 0, read = 0, unchanged = 0, ticked = 0;
    for (const p of projects ?? []) {
      let folderId = p.drive_folder_id as string | null;
      if (!folderId) {
        const keys = [p.name, ...(p.diary_aliases ?? [])].map((n: string) => siteKey(n)).filter((k: string) => k.length >= 4);
        const exact = folders.filter((f) => keys.includes(siteKey(f.name)));
        const loose = folders.filter((f) => { const k = siteKey(f.name); return k.length >= 5 && keys.some((x: string) => x.length >= 5 && (x.startsWith(k) || k.startsWith(x))); });
        const hit = exact.length === 1 ? exact[0] : !exact.length && loose.length === 1 ? loose[0] : null;
        if (!hit) continue;
        folderId = hit.id;
        await admin.from("projects").update({ drive_folder_id: folderId }).eq("id", p.id);
        linked++;
      }
      // the newest diary: in "Diaries" (or a sub-folder whose name says diary/report), else the folder itself
      const subs = await list(`'${folderId}' in parents and mimeType = '${FOLDER}' and trashed = false`);
      const places = [...subs.filter((s) => /diar/i.test(s.name)), ...subs.filter((s) => /report/i.test(s.name) && !/monthly/i.test(s.name)), { id: folderId } as F];
      let newest: F | undefined;
      for (const pl of places) {
        const docs = (await list(`'${pl.id}' in parents and mimeType = '${DOCX}' and trashed = false`)).filter((f) => /diar|report|cow/i.test(f.name));
        newest = docs.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))[0];
        if (newest) break;
      }
      if (!newest) continue;
      const prev = (p.details ?? {}) as Record<string, string>;
      if (prev._file_id === newest.id && prev._modified === newest.modifiedTime) { unchanged++; continue; }
      let front: Record<string, string>;
      try { front = await readDiaryFront(Buffer.from(await g.download(newest.id))); } catch { continue; }
      if (!Object.keys(front).length) continue;
      await admin.from("projects").update({ details: { ...prev, ...front, _file: newest.name, _file_id: newest.id, _modified: newest.modifiedTime } }).eq("id", p.id);
      read++;

      const src = `From the CoW diary (${newest.name.slice(0, 60)})`;
      const values: [RegExp, string | undefined][] = [
        [/DfE project director/i, front.dfe_project_director],
        [/DfE project manager/i, front.dfe_project_manager],
        [/DfE project number/i, front.dfe_project_number],
        [/Principal contractor project number/i, front.pc_project_number],
        [/TA name/i, front.ta_name && `${front.ta_name}${front.ta_firm ? ` (${front.ta_firm})` : ""}`],
        [/Principal contractor project manager/i, front.pc_project_manager && `${front.pc_project_manager}${front.principal_contractor ? ` (${front.principal_contractor})` : ""}`],
      ];
      const today = new Date().toISOString().slice(0, 10);
      for (const [re, v] of values) {
        if (unknown(v)) continue;
        for (const i of (infoRows ?? []).filter((x) => x.project_id === p.id && re.test(x.item))) {
          if (i.received_on && i.note && !/^(Assumed|From the CoW diary)/.test(i.note)) continue; // someone entered it by hand
          await admin.from("project_info").update({ received_on: i.received_on ?? today, note: `${src}: ${v}`.slice(0, 500) }).eq("id", i.id);
          ticked++;
        }
      }
      if (front.dfe_project_number && !unknown(front.dfe_project_number))
        await admin.from("projects").update({ dfe_project_number: front.dfe_project_number.replace(/\s+/g, "") }).eq("id", p.id).is("dfe_project_number", null);
    }
    const msg = `${linked} projects linked to their Drive folder, ${read} CoW diaries read, ${unchanged} unchanged, ${ticked} checklist items filled in`;
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await finish(false, m);
    return { ok: false, message: m };
  }
}
