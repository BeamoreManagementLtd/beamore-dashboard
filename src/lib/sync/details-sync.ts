import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { siteKey } from "@/lib/site-key.mjs";
import { readDiaryFront } from "@/lib/sync/diary-front.mjs";
import { clerkKey } from "@/lib/site-key.mjs";
import { draftExpiryChasers } from "@/lib/clerk-expiry";
import { setupProjectTracking } from "@/lib/xero-tracking";

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

    const { data: clerkRows } = await admin.from("clerks").select("id,name");
    const clerkByKey = new Map((clerkRows ?? []).map((c) => [clerkKey(c.name), c.id as string]));
    // "Gareth Mayoh – Beamore Management Ltd" → the clerk
    const clerkFrom = (v?: string) => (v ? clerkByKey.get(clerkKey(v.split(/\s+[–-]\s+/)[0])) ?? null : null);
    let meFound = 0;
    const { data: projects } = await admin.from("projects").select("id,name,display_name,diary_aliases,drive_folder_id,details,clerk_me_id,clerk_me_source,clerk_me_status")
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
      // the M&E clerk from the newest report in the M&E folder, when the diary hasn't given one
      if (!p.clerk_me_id && p.clerk_me_source !== "manual" && p.clerk_me_status !== "none") {
        for (const meDir of subs.filter((s) => /M\s*&\s*E/i.test(s.name) && !/photo/i.test(s.name))) {
          const docs = (await list(`'${meDir.id}' in parents and mimeType = '${DOCX}' and trashed = false`)).sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
          if (!docs[0]) continue;
          try {
            const front = (await readDiaryFront(Buffer.from(await g.download(docs[0].id)))) as Record<string, string>;
            const id = clerkFrom(front.cow_name);
            if (id) {
              await admin.from("projects").update({ clerk_me_id: id, clerk_me_source: "diary", clerk_me_status: "have" }).eq("id", p.id);
              await admin.from("project_events").insert({ project_id: p.id, source: "dashboard", kind: "M&E clerk of works", who: "Dashboard", body: `${front.cow_name.split(/\s+[–-]\s+/)[0]} (from the M&E report "${docs[0].name.slice(0, 70)}")` });
              meFound++;
              break;
            }
          } catch { /* unreadable report: try the next folder */ }
        }
      }
      const places = [...subs.filter((s) => /diar/i.test(s.name) && !/M\s*&\s*E/i.test(s.name)), ...subs.filter((s) => /report/i.test(s.name) && !/monthly|M\s*&\s*E/i.test(s.name)), { id: folderId } as F];
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
      try { front = (await readDiaryFront(Buffer.from(await g.download(newest.id)))) as Record<string, string>; } catch { continue; }
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
    // ---- PO / invoicing numbers. (a) the client's job code on our Xero invoices ("LNMS0296 - HighamPark") answers
    // "PO or project number for invoicing"; (b) PO numbers quoted in email about the project (50 projects a day).
    const today = new Date().toISOString().slice(0, 10);
    const canTick = (i: { received_on: string | null; note: string | null }) => !(i.received_on && i.note && !/^(Assumed|From the CoW diary|From the diary|From Xero|From email)/.test(i.note));
    const { data: refs } = await admin.from("invoices").select("project_id,reference,issued").in("project_id", (projects ?? []).map((p) => p.id)).order("issued", { ascending: false });
    let pos = 0;
    for (const p of projects ?? []) {
      const code = (refs ?? []).filter((r) => r.project_id === p.id).map((r) => /^\s*([A-Z]{2,5}\s?\d{3,5})\s*-/.exec(r.reference ?? "")?.[1]).find(Boolean);
      if (!code) continue;
      for (const i of (infoRows ?? []).filter((x) => x.project_id === p.id && /PO or project number/i.test(x.item) && canTick(x))) {
        await admin.from("project_info").update({ received_on: i.received_on ?? today, note: `From Xero: invoices quote ${code}` }).eq("id", i.id);
        ticked++;
      }
    }
    const { data: noPo } = await admin.from("projects").select("id,name,details").in("id", (projects ?? []).map((p) => p.id)).is("po_number", null);
    const due = (noPo ?? []).filter((p) => ((p.details ?? {}) as Record<string, string>)._po_checked !== today)
      .sort((a, b) => String(((a.details ?? {}) as Record<string, string>)._po_checked ?? "").localeCompare(String(((b.details ?? {}) as Record<string, string>)._po_checked ?? ""))).slice(0, 50);
    const PO = /(?:purchase order|\bP\.?O\.?)\s*(?:number|no\.?|num|#|ref(?:erence)?)?\s*(?:is|=|:|-)?\s*([A-Z]{0,4}[-/]?\d[\dA-Z\-/]{3,})/i;
    type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };
    const textOf = (pt: Part): string => (pt.mimeType === "text/plain" && pt.body?.data ? Buffer.from(pt.body.data, "base64url").toString("utf8") : (pt.parts ?? []).map(textOf).join("\n"));
    for (const p of due) {
      const found = await g.gmail<{ messages?: { id: string }[] }>("messages", { q: `"${p.name.replace(/"/g, "")}" ("purchase order" OR "PO number" OR "PO no" OR "PO ref") newer_than:2y`, maxResults: "3" });
      let hit: { po: string; subject: string; date: string } | null = null;
      for (const m of found.messages ?? []) {
        const f = await g.gmail<{ snippet?: string; internalDate: string; payload: Part & { headers: { name: string; value: string }[] } }>(`messages/${m.id}`, { format: "full" });
        const newest = textOf(f.payload).split(/\n(?:From:|On .* wrote:)/)[0]; // not the quoted history
        const x = PO.exec(`${f.snippet ?? ""}\n${newest}`);
        if (x && /\d{4,}/.test(x[1])) { hit = { po: x[1], subject: f.payload.headers.find((h) => h.name === "Subject")?.value ?? "", date: new Date(Number(f.internalDate)).toISOString().slice(0, 10) }; break; }
      }
      await admin.from("projects").update({ details: { ...((p.details ?? {}) as Record<string, string>), _po_checked: today }, ...(hit ? { po_number: hit.po } : {}) }).eq("id", p.id);
      if (!hit) continue;
      pos++;
      for (const i of (infoRows ?? []).filter((x) => x.project_id === p.id && /\bPO\b/.test(x.item) && canTick(x))) {
        await admin.from("project_info").update({ received_on: i.received_on ?? today, note: `From email "${hit.subject.slice(0, 80)}" (${hit.date}): PO ${hit.po}` }).eq("id", i.id);
        ticked++;
      }
    }

    // clerks' renewals due within 30 days: one renewal-request draft each
    let expiryDrafts = 0;
    try { expiryDrafts = await draftExpiryChasers(admin); } catch { /* try again tomorrow */ }

    // Xero Project tracking options rotate (it has its own sync_runs row)
    try { await setupProjectTracking(admin); } catch { /* logged in its own run */ }

    const msg = `${expiryDrafts} renewal-request drafts, ${linked} projects linked to their Drive folder, ${read} CoW diaries read, ${meFound} M&E clerks from M&E reports, ${unchanged} unchanged, ${pos} PO numbers found in email, ${ticked} checklist items filled in`;
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await finish(false, m);
    return { ok: false, message: m };
  }
}
