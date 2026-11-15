import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { driveClient } from "@/lib/google";
import { projectMatcher } from "@/lib/project-match";
import { sendReportEmail } from "@/lib/google-user";
import { readReport, photoStats, shrinkPhotos, trackSpelling, addComments, saveReport, photoHashes, reusedCount, uncaptioned, unticked, rotatePhoto, fixPhotoShapes, uniformPhotos } from "./docx.mjs";

/** 0-100: how much the report needed fixing (must-checks count most). Lateness is shown separately. */
/**
 * 0-100: how much the report needed fixing. Everything the dashboard had to put right counts (Ronan, 15 Nov 2026),
 * not just what's left for the team: issues, spelling, the file name, mixed photo sizes, sideways, stretched or
 * oversized photos.
 */
export function qualityScore(issues: { severity: string }[], spelling: number, lateDays: number, f: { renamed?: boolean; mixedPhotos?: boolean; rotated?: number; stretched?: number; oversized?: boolean } = {}) {
  const w = { high: 15, medium: 6, low: 2 } as Record<string, number>;
  const off = issues.reduce((n, i) => n + (w[i.severity] ?? 0), 0) + Math.min(10, spelling) + Math.min(15, lateDays * 5)
    + (f.renamed ? 5 : 0) + (f.mixedPhotos ? 5 : 0) + Math.min(9, (f.rotated ?? 0) * 3) + Math.min(6, (f.stretched ?? 0) * 2) + (f.oversized ? 3 : 0);
  return Math.max(0, 100 - off);
}
import { checkReport, type Issue, type Programme } from "./check";

/** What a progress vs programme section is missing, against Ronan's method, in words for the checker and the clerk. */
export function programmeGaps(p: Programme | null | undefined) {
  if (!p || p.verdict === "good" || p.verdict === "not_in_form") return [];
  // other clients' reports: the progress summary, Damian's and Keith's way
  if (!p.dfe) return [p.verdict === "missing"
    ? "open with a progress summary: area by area and level by level, what's complete, what's outstanding, and whether the completion date looks realistic"
    : "make the progress summary fuller: progress area by area, what's outstanding, and your view on the completion date"];
  if (p.verdict === "missing") return ["say which programme you're working from, list 8-10 activities (preferably on the critical path) with weeks ahead/behind for each, then at least 5-6 lines on where you think the project is overall"];
  return [
    !p.programme_named ? "say which programme you're measuring against (title and revision/date)" : "",
    p.items < 8 ? `only ${p.items} activit${p.items === 1 ? "y" : "ies"} listed (aim for 8-10, preferably on the critical path)` : "",
    !p.per_item_weeks ? 'say how many weeks ahead or behind each activity is, e.g. "Installation of staircases – 3 weeks behind"' : "",
    !p.critical_path ? "include activities on the critical path" : "",
    !p.narrative ? "add at least 5-6 lines weighing up all the items, the causes, and where you think the project is" : "",
    !p.overall_weeks ? 'give your overall view in weeks, e.g. "I estimate the contractor is 3.5 weeks behind programme"' : "",
    p.looks_from_site_team ? "give your own independent view, not the site team's figures" : "",
    p.percentages_shown ? "leave percentages out (use them to work out the weeks only)" : "",
  ].filter(Boolean);
}
import { conventionName } from "./naming.mjs";

/**
 * Report checking (Ronan, 15 Nov 2026), replacing the "Ready To Check" and turnaround spreadsheets:
 *  1. find: every Word report in a project's report folders (Schools/Others → project → Diaries, M&E Diaries, Reports…)
 *     that has no PDF yet; a PDF with the same name means it's been done
 *  2. check: once the clerk has finished with it (30 minutes untouched), the AI fixes spelling as tracked changes, shrinks
 *     oversized photos and comments on anything the checker should look at; the Word file keeps its place and name, and
 *     Drive keeps the clerk's version in its history
 *  3. approve and send: the checker's click makes the PDF (with their edits), saves it next to the Word file and emails
 *     it from their own Gmail to the project's report list, using the team's standard email
 */
const MAIN_FOLDER_NAME: Record<string, string> = { "0B5LaG4Rs3CgQd2VIeW5Ya3F3SnM": "Schools", "0B5LaG4Rs3CgQaElqRFNsNWRQcUk": "Others" }; // under Work
const MAIN_FOLDERS = new Set(Object.keys(MAIN_FOLDER_NAME));
const REPORT_FOLDER = /^(m&e |mep )?(diar(ies|y)|diaires|reports?|monthly reports?|site diar(ies|y))\s*$/i;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SETTLE_MS = 30 * 60 * 1000;
const base = (name: string) => name.replace(/\.(docx?|pdf)$/i, "").toLowerCase().replace(/\s*\(\d+\)\s*$/, "").replace(/(\s+copy)+$/, "").replace(/[^a-z0-9]/g, "");

type DriveFile = { id: string; name: string; parents?: string[]; createdTime: string; modifiedTime: string };
type Folder = { id: string; name: string; parents?: string[] };

async function listAll(g: Awaited<ReturnType<typeof driveClient>>, q: string) {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const r = await g.json<{ files: DriveFile[]; nextPageToken?: string }>("files", { q, fields: "nextPageToken,files(id,name,parents,createdTime,modifiedTime)", pageSize: "1000", includeItemsFromAllDrives: "true", supportsAllDrives: "true", ...(pageToken ? { pageToken } : {}) });
    out.push(...r.files); pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}

/** 1. Finds new Word reports and reports that have since got a PDF. */
export async function scanReports(admin: SupabaseClient) {
  const g = await driveClient(admin);
  const { data: last } = await admin.from("sync_files").select("modified_time").eq("key", "report_scan").maybeSingle();
  const started = new Date().toISOString();
  const since = last?.modified_time ? new Date(Date.parse(last.modified_time) - 3600_000).toISOString() : new Date(Date.now() - 21 * 864e5).toISOString();
  const pdfSince = last?.modified_time ? since : new Date(Date.now() - 60 * 864e5).toISOString();
  const [docs, pdfs] = await Promise.all([
    listAll(g, `mimeType='${DOCX}' and trashed=false and modifiedTime > '${since}'`),
    listAll(g, `mimeType='application/pdf' and trashed=false and modifiedTime > '${pdfSince}'`),
  ]);

  // folders: report folder → project folder → Schools/Others
  const folders = new Map<string, Folder | null>();
  const folder = async (id?: string) => {
    if (!id) return null;
    if (!folders.has(id)) folders.set(id, await g.json<Folder>(`files/${id}`, { fields: "id,name,parents", supportsAllDrives: "true" }).catch(() => null));
    return folders.get(id) ?? null;
  };
  const { data: projects } = await admin.from("projects").select("id,name,diary_aliases,drive_folder_id,clerk_id,clerk_me_id,report_checker_id");
  const match = projectMatcher((projects ?? []).map((p) => ({ id: p.id, name: p.name, diary_aliases: p.diary_aliases ?? [] })));
  const byFolder = new Map((projects ?? []).filter((p) => p.drive_folder_id).map((p) => [p.drive_folder_id as string, p]));
  // who checks: the project's checker, else who the old spreadsheet gave it to
  const [{ data: staff }, { data: oldQueue }] = await Promise.all([admin.from("profiles").select("id,full_name,email"), admin.from("report_queue").select("project_id,checker")]);
  const byFirst = (n?: string | null) => (n ? (staff ?? []).find((s) => (s.full_name ?? s.email).toLowerCase().startsWith(n.toLowerCase().replace(/é/g, "e")) || (s.full_name ?? "").toLowerCase().replace(/é/g, "e").startsWith(n.toLowerCase()))?.id ?? null : null);

  // the dashboard's own checked copies aren't new reports
  const copies = new Set(((await admin.from("reports").select("checked_file_id").not("checked_file_id", "is", null)).data ?? []).map((x) => x.checked_file_id as string));
  let found = 0;
  for (const f of docs) {
    if (f.name.startsWith("~$") || copies.has(f.id)) continue;
    const rf = await folder(f.parents?.[0]);
    if (!rf || !REPORT_FOLDER.test(rf.name.trim())) continue;
    const pf = await folder(rf.parents?.[0]);
    if (!pf || !MAIN_FOLDERS.has(pf.parents?.[0] ?? "")) continue;
    const p = byFolder.get(pf.id) ?? (projects ?? []).find((x) => x.id === match.fromReference(pf.name));
    const kind = /m&e|mep/i.test(rf.name) ? "me" : "building";
    const { data: existing } = await admin.from("reports").select("id,status,checked_at").eq("drive_file_id", f.id).maybeSingle();
    if (existing) {
      // the clerk changed their original after it was checked: say so (the checked copy may be out of date)
      const changedAfter = existing.checked_at && Date.parse(f.modifiedTime) > Date.parse(existing.checked_at) + 5 * 60_000 && ["ready", "failed"].includes(existing.status);
      await admin.from("reports").update({ file_name: f.name, modified_at: f.modifiedTime, ...(changedAfter ? { error: "The clerk has changed their report since it was checked. Check it again to update the checked copy (anything changed in the copy by hand would be lost)." } : {}) }).eq("id", existing.id);
      continue;
    }
    await admin.from("reports").insert({
      drive_file_id: f.id, file_name: f.name, folder_id: rf.id, folder_name: rf.name.trim(), project_folder_id: pf.id, project_folder_name: pf.name,
      project_id: p?.id ?? null, kind, clerk_id: p ? (kind === "me" ? p.clerk_me_id ?? p.clerk_id : p.clerk_id) : null,
      uploaded_at: f.createdTime, modified_at: f.modifiedTime, main_folder: MAIN_FOLDER_NAME[pf.parents?.[0] ?? ""] ?? null,
      checker_id: p?.report_checker_id ?? byFirst((oldQueue ?? []).find((q) => q.project_id === p?.id && q.checker && q.checker !== "Unknown")?.checker),
    });
    found++;
  }

  // a PDF of the same name in the same folder: that report is done
  let done = 0;
  const open = new Map<string, { id: string; bases: string[] }[]>();
  for (const r of (await admin.from("reports").select("id,folder_id,checked_folder_id,file_name,checked_name").in("status", ["new", "checking", "ready", "failed"])).data ?? []) {
    // a PDF made by hand from the clerk's file or from the checked copy, in the report folder or the checked folder
    const entry = { id: r.id, bases: [base(r.file_name), ...(r.checked_name ? [base(r.checked_name)] : [])] };
    for (const fid of [r.folder_id, r.checked_folder_id].filter(Boolean)) open.set(fid, [...(open.get(fid) ?? []), entry]);
  }
  for (const pdf of pdfs) {
    const hit = (open.get(pdf.parents?.[0] ?? "") ?? []).find((r) => r.bases.includes(base(pdf.name)));
    if (!hit) continue;
    await admin.from("reports").update({ status: "done", pdf_file_id: pdf.id, done_at: pdf.createdTime, updated_at: started }).eq("id", hit.id).neq("status", "sent");
    done++;
  }
  // reports nobody's checking yet: the project's checker, or the old spreadsheet's choice once that person has a login
  for (const r of (await admin.from("reports").select("id,project_id").is("checker_id", null).in("status", ["new", "checking", "ready", "failed"])).data ?? []) {
    const p = (projects ?? []).find((x) => x.id === r.project_id);
    const who = p?.report_checker_id ?? byFirst((oldQueue ?? []).find((q) => q.project_id === r.project_id && q.checker && q.checker !== "Unknown")?.checker);
    if (who) await admin.from("reports").update({ checker_id: who }).eq("id", r.id);
  }
  await admin.from("sync_files").upsert({ key: "report_scan", file_id: "drive", modified_time: started, read_at: started });
  return { found, done };
}

/** 2. Checks reports the clerks have finished with, oldest first, within the time given. */
export async function checkWaiting(admin: SupabaseClient, budgetMs = 200_000) {
  const t0 = Date.now();
  const { data: waiting } = await admin.from("reports").select("id").eq("status", "new").lt("modified_at", new Date(Date.now() - SETTLE_MS).toISOString()).order("uploaded_at").limit(25);
  let checked = 0, failed = 0;
  for (const w of waiting ?? []) {
    if (Date.now() - t0 > budgetMs) break;
    try { await checkOne(admin, w.id); checked++; } catch (e) {
      failed++;
      await admin.from("reports").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 500), updated_at: new Date().toISOString() }).eq("id", w.id);
    }
  }
  return { checked, failed };
}

export async function checkOne(admin: SupabaseClient, id: string) {
  const { data: rep } = await admin.from("reports").update({ status: "checking", error: null }).eq("id", id).select("*").single();
  if (!rep) throw new Error("No such report");
  const g = await driveClient(admin);
  const meta = await g.json<{ headRevisionId: string; modifiedTime: string; size: string }>(`files/${rep.drive_file_id}`, { fields: "headRevisionId,modifiedTime,size", supportsAllDrives: "true" });
  const raw = Buffer.from(await g.download(rep.drive_file_id));
  const r = await readReport(raw);
  const stats = await photoStats(r, sharp);

  // what the check needs to know about the job
  const { data: p } = rep.project_id ? await admin.from("projects").select("id,name,dfe_project_number,po_number,clerk_id,clerk_me_id,clients(name)").eq("id", rep.project_id).single() : { data: null };
  const clerkIds = [p?.clerk_id, p?.clerk_me_id].filter(Boolean) as string[];
  const { data: clerks } = clerkIds.length ? await admin.from("clerks").select("id,name").in("id", clerkIds) : { data: [] };
  const since = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const { data: visits } = rep.project_id ? await admin.from("diary_visits").select("visit_date,side,clerks(name)").eq("project_id", rep.project_id).gte("visit_date", since).order("visit_date") : { data: [] };
  const visitList = [...new Set((visits ?? []).map((v) => `${v.visit_date} ${(v.clerks as unknown as { name?: string } | null)?.name ?? ""}${v.side === "planned" ? " (planned)" : ""}`.trim()))];
  const { data: earlier } = rep.project_id ? await admin.from("reports").select("report_number,visit_date,text_snapshot,photo_hashes,photo_count").eq("project_id", rep.project_id).eq("kind", rep.kind).neq("id", id).not("checked_at", "is", null).order("uploaded_at", { ascending: false }).limit(5) : { data: [] };
  const prev = earlier?.[0] ?? null;
  const counts = (earlier ?? []).map((e) => e.photo_count).filter((n): n is number => typeof n === "number");
  const usual = counts.length >= 2 ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : null;
  const hashes = await photoHashes(r, sharp, stats);
  const reused = reusedCount(hashes, prev?.photo_hashes ?? null);
  // up to 12 photos for the AI to look at (spread through the report), remembering which file each one is
  const used = stats.list.filter((x) => x.used);
  const picked = used.length <= 12 ? used : Array.from({ length: 12 }, (_, k) => used[Math.floor((k * used.length) / 12)]);
  const thumbs: Buffer[] = [], thumbPaths: string[] = [];
  for (const ph of picked) {
    try { thumbs.push(await sharp(await r.zip.file(ph.path)!.async("nodebuffer"), { failOn: "none" }).rotate().resize({ width: 320, height: 320, fit: "inside" }).jpeg({ quality: 55 }).toBuffer()); thumbPaths.push(ph.path); } catch { /* skip */ }
  }

  const ai = await checkReport({
    fileName: rep.file_name, folder: rep.folder_name ?? "", project: p?.name ?? rep.project_folder_name ?? "", client: (p?.clients as unknown as { name?: string } | null)?.name ?? null,
    projectNumbers: [p?.dfe_project_number, p?.po_number].filter((x): x is string => !!x && /\d/.test(x)),
    expectedClerks: (clerks ?? []).map((c) => c.name), diaryVisits: visitList,
    previous: prev ? { number: prev.report_number, date: prev.visit_date, text: prev.text_snapshot ?? "" } : null,
    paragraphs: r.paragraphs, blanks: r.blanks, placeholders: r.placeholders,
    photos: { count: stats.count, blurry: stats.blurry, smallOnPage: stats.smallOnPage, stretched: stats.stretched, mb: raw.length / 1e6, usual, reused, uncaptioned: uncaptioned(r) },
    unticked: unticked(r), thumbnails: thumbs, today: new Date().toISOString().slice(0, 10),
  });

  // first: the file name follows the pattern of the other reports in its folder (next number, this visit's date)
  const visitDate = ai.visit_date && /^\d{4}-\d{2}-\d{2}$/.test(ai.visit_date) ? ai.visit_date : null;
  let renamedTo: string | null = null;
  try {
    const sibs = await g.json<{ files: { name: string }[] }>("files", { q: `'${rep.folder_id}' in parents and trashed = false and (mimeType = '${DOCX}' or mimeType = 'application/pdf')`, fields: "files(name)", orderBy: "modifiedTime desc", pageSize: "40", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const want = conventionName(rep.file_name, sibs.files.map((f) => f.name).filter((n) => n !== rep.file_name), visitDate, ai.report_number);
    if (want && !sibs.files.some((f) => f.name.toLowerCase() === want.toLowerCase())) renamedTo = want;
  } catch { /* keep the name */ }

  // put the fixes into the Word file: spelling, grammar and punctuation as tracked changes, photos turned upright, all
  // the same size (Christian's: 6 cm squares) and made smaller, issues as comments
  const rotated: string[] = [];
  for (const t of ai.rotate ?? []) {
    const path = thumbPaths[t.photo - 1];
    if (path && !rotated.includes(path)) { await rotatePhoto(r, sharp, path, t.degrees); rotated.push(path); }
  }
  // blank boxes are left for the clerk (Ronan, 15 Nov 2026); photo shapes and sizes are put right
  // every photo the same size (Christian's format); where that can't apply, at least stretched/tiny photos put right
  const uniform = uniformPhotos(r, await photoStats(r, sharp), await r.zip.file("word/_rels/document.xml.rels")!.async("string"));
  const shapes = uniform.changed ? { stretched: 0, enlarged: 0 } : await fixPhotoShapes(r, await photoStats(r, sharp));
  const shrunk = await shrinkPhotos(r, sharp, await photoStats(r, sharp));
  const spelt = trackSpelling(r, ai.spelling);
  const rank = { high: 0, medium: 1, low: 2 } as const;
  // not enough photos or not enough written, against the benchmark clerks' reports (weekly diaries: 35-57 photos,
  // 1,800-5,000 words); monthly reports aren't judged on this
  const words = r.paragraphs.reduce((n, p) => n + (p.text.match(/[A-Za-z]{2,}/g) ?? []).length, 0);
  const monthly = /monthly/i.test(rep.folder_name ?? "") || /monthly/i.test(rep.file_name);
  const min = rep.kind === "me" ? { photos: 12, words: 800 } : { photos: 20, words: 1200 };
  const extra: Issue[] = [];
  if (!monthly && stats.count < min.photos) extra.push({ severity: "medium", kind: "photos", text: `Only ${stats.count} photo${stats.count === 1 ? "" : "s"}: good reports have ${rep.kind === "me" ? "20 or more" : "35-50"}${usual ? ` (this clerk usually has about ${usual} here)` : ""}`, p: null });
  if (!monthly && words < min.words) extra.push({ severity: "medium", kind: "vague", text: `Not much written (about ${words} words): good reports describe each area in detail, typically ${rep.kind === "me" ? "1,000+" : "1,800-5,000"} words`, p: null });
  // progress vs programme, the Beamore way (Ronan's "Site Diaries" email, Aug 2024): raised even if the AI didn't list it
  const prog = ai.programme;
  const progGaps = programmeGaps(prog);
  if (prog && prog.verdict !== "good" && prog.verdict !== "not_in_form" && !ai.issues.some((i) => i.kind === "programme"))
    extra.push({ severity: prog.verdict === "missing" && prog.dfe ? "high" : "medium", kind: "programme", text: `${prog.dfe ? "Progress vs programme" : "Progress summary"} ${prog.verdict === "missing" ? "not done" : "falls short"}: ${progGaps.join("; ") || prog.note}`, p: prog.p });
  const issues: Issue[] = [...extra, ...ai.issues].sort((a, b) => rank[a.severity] - rank[b.severity]);
  if (spelt.skipped.length) issues.push({ severity: "low", kind: "other", text: `Spelling not changed automatically (please fix by hand): ${spelt.skipped.slice(0, 8).map((s) => `${s.find} → ${s.replace}`).join(", ")}`, p: null });
  await addComments(r, issues.filter((i) => i.severity !== "low").slice(0, 15).map((i) => ({ p: i.p, text: `${i.severity === "high" ? "Must check: " : ""}${i.text}` })));
  const out = await saveReport(r);

  // only if the clerk hasn't changed it while we were checking
  const now = await g.json<{ headRevisionId: string }>(`files/${rep.drive_file_id}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  if (now.headRevisionId !== meta.headRevisionId) {
    await admin.from("reports").update({ status: "new", modified_at: new Date().toISOString() }).eq("id", id);
    return;
  }
  // the fixed version is a COPY in a "Checked (dashboard)" folder next to the clerk's file, named to the folder's
  // pattern; the clerk's own file isn't touched (Ronan, 15 Nov 2026), and is only binned once the copy has been sent
  const checkedFolder = rep.checked_folder_id ?? await checkedFolderFor(g, rep.folder_id);
  const checkedName = renamedTo ?? rep.checked_name ?? rep.file_name;
  let checkedId = rep.checked_file_id as string | null;
  if (checkedId) {
    await g.replaceContent(checkedId, out, DOCX);
    if (checkedName !== rep.checked_name) await g.rename(checkedId, checkedName).catch(() => undefined);
  } else checkedId = (await g.putFile(checkedName, checkedFolder, out, DOCX)).id;
  const after = await g.json<{ headRevisionId: string }>(`files/${checkedId}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  await admin.from("reports").update({ checked_file_id: checkedId, checked_folder_id: checkedFolder, checked_name: checkedName, renamed_from: renamedTo ? rep.file_name : null }).eq("id", id);
  const visitFromName = /(\d{1,2})[.\-_ ](\d{1,2})[.\-_ ](\d{2,4})/.exec(rep.file_name);
  const nameDate = visitFromName ? `${visitFromName[3].length === 2 ? `20${visitFromName[3]}` : visitFromName[3]}-${visitFromName[2].padStart(2, "0")}-${visitFromName[1].padStart(2, "0")}` : null;
  const applied = ai.spelling.filter((s) => !spelt.skipped.includes(s)).map((s) => ({ find: s.find, replace: s.replace }));
  await admin.from("reports").update({
    status: "ready", ai_summary: ai.summary, issues, spelling_fixed: spelt.applied,
    photos: { count: stats.count, blurry: stats.blurry, smallOnPage: stats.smallOnPage, stretched: stats.stretched, shrunk: shrunk.changed, rotated: rotated.length, reused, usual, uncaptioned: uncaptioned(r) },
    photo_hashes: hashes, photo_count: stats.count,
    fixes: { spelling: applied, rotated: rotated.length, shrunk: shrunk.changed, stretched: shapes.stretched, enlarged: shapes.enlarged, uniform: uniform.changed, mixed: !uniform.wasUniform, side_cm: uniform.side ? +(uniform.side / 360000).toFixed(1) : null, renamed: renamedTo, words, programme: prog ?? null },
    // lateness is shown on its own on the Reports page
    score: qualityScore(issues, spelt.applied, 0, { renamed: !!renamedTo, mixedPhotos: !uniform.wasUniform, rotated: rotated.length, stretched: stats.stretched, oversized: shrunk.changed > 0 && raw.length > 10_000_000 }),
    clerk_points: [
      ...(renamedTo ? [`Name your reports the same way as the others in the folder, e.g. "${renamedTo.replace(/\.docx?$/i, "")}"`] : []),
      ...(!uniform.wasUniform ? ["Keep all photos the same size: about 6 cm wide (6 x 4.5 cm landscape, 4.5 x 6 cm portrait), two to a line"] : []),
      ...(rotated.length ? ["Check photos are the right way up before inserting them"] : []),
      ...(stats.stretched ? ["Resize photos from a corner (or hold Shift) so they don't stretch out of shape"] : []),
      ...(raw.length > 10_000_000 ? [`Make photos smaller before inserting them: this report was ${(raw.length / 1e6).toFixed(0)} MB (Word: Picture Format > Compress Pictures)`] : []),
      ...(prog && (prog.verdict === "weak" || prog.verdict === "missing") ? [`${prog.dfe ? "Progress vs programme" : "Progress summary"}: ${progGaps.join("; ") || "follow the Beamore method"}`] : []),
      ...(ai.clerk_points ?? []),
    ].slice(0, 8),
    size_before: raw.length, size_after: out.length, checked_revision: after.headRevisionId, checked_at: new Date().toISOString(),
    visit_date: ai.visit_date && /^\d{4}-\d{2}-\d{2}$/.test(ai.visit_date) ? ai.visit_date : (nameDate && !Number.isNaN(Date.parse(nameDate)) ? nameDate : null),
    report_number: ai.report_number, clerk_name: ai.clerk_name,
    text_snapshot: r.paragraphs.map((x) => x.text).filter((x) => x.trim()).join("\n").slice(0, 20000),
    modified_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", id);
}

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);
const ukDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");

/** The standard email filled in for one report (the checker can still change it before sending). */
export async function draftFor(admin: SupabaseClient, reportId: string, sender: { full_name: string | null; email: string }) {
  const [{ data: rep }, { data: s }] = await Promise.all([
    admin.from("reports").select("*,projects(name,report_to,report_cc)").eq("id", reportId).single(),
    admin.from("report_settings").select("*").eq("id", 1).single(),
  ]);
  const p = (rep?.projects ?? null) as { name?: string; report_to?: string | null; report_cc?: string | null } | null;
  const v = { project: p?.name ?? rep?.project_folder_name ?? "", report_number: rep?.report_number ?? "", visit_date: ukDate(rep?.visit_date ?? null), clerk: rep?.clerk_name ?? "", sender_name: sender.full_name ?? sender.email, sender_first_name: (sender.full_name ?? sender.email).split(" ")[0] };
  const emails = (s?: string | null) => [...new Set((s ?? "").match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])];
  return {
    to: emails(p?.report_to), cc: emails(p?.report_cc),
    subject: fill(s?.email_subject ?? "", v).replace(/\s+–\s+(?=–|$)/g, " ").replace(/\s{2,}/g, " ").trim(),
    body: fill(s?.email_body ?? "", v),
  };
}

/**
 * The standard file name, like the best clerks use: "37 - Pershore - CoW Diary - 10.11.2026". Files named with a
 * client's document code (SRP1065-BML-…, TAS2025-DFE-…) keep their name: the client's document control relies on it.
 */
export function standardName(rep: { file_name: string; report_number: string | null; visit_date: string | null; folder_name: string | null }, project: string) {
  if (/^(SRP\s?\d|TAS20|PSBP|[A-Z0-9]{2,}-[A-Z0-9]{2,}-[A-Z0-9]{2,}-)/i.test(rep.file_name)) return null;
  const num = (rep.report_number ?? "").replace(/^(no\.?|r)\s*/i, "").trim();
  if (!num || !/^\d{1,4}$/.test(num) || !rep.visit_date || !project) return null;
  const f = (rep.folder_name ?? "").toLowerCase();
  const kind = /monthly/.test(f) ? "Monthly Report" : /m&e|mep/.test(f) ? (/report/.test(f) ? "M&E CoW Report" : "M&E CoW Diary") : /report/.test(f) ? "CoW Report" : "CoW Diary";
  const [y, m, d] = rep.visit_date.split("-");
  const clean = project.replace(/[\\/:*?"<>|]/g, "").trim();
  return `${num.padStart(2, "0")} - ${clean} - ${kind} - ${d}.${m}.${y}.docx`;
}


/**
 * 3. The checker's "Approve and send" (Ronan, 15 Nov 2026: the PDF must come from Word, not Google):
 *  a. the email is kept with the report and the report is queued for its PDF
 *  b. the helper on the office PC opens a copy in Word, accepts any tracked changes left, takes the comments out,
 *     saves the PDF next to the report (Google Drive for desktop uploads it) and says so
 *  c. the dashboard finds the PDF in Drive and emails it from the checker's own Gmail
 * The PDF has the Word file's name, which already follows the folder's pattern (renamed when it was checked).
 */
export async function approveReport(admin: SupabaseClient, reportId: string, who: { id: string; full_name: string | null }, m: { to: string[]; cc: string[]; subject: string; body: string }) {
  if (!m.to.length) throw new Error("Nobody to send it to: add the report list on the project's page");
  const { data: rep } = await admin.from("reports").select("*").eq("id", reportId).single();
  if (!rep) throw new Error("No such report");
  if (rep.status === "sent") throw new Error("Already sent");
  if (!rep.main_folder) throw new Error("Can't tell where this report is on the office PC; please make the PDF in Word by hand");
  if (!rep.checked_file_id) throw new Error("This report hasn't been checked yet");
  const pdfName = `${String(rep.checked_name ?? rep.file_name).replace(/\.docx?$/i, "")}.pdf`;
  await admin.from("reports").update({
    status: "approved", approved_by: who.id, approved_at: new Date().toISOString(), error: null,
    pending_email: { ...m, by: who.id, by_name: who.full_name }, pdf_name: pdfName, pdf_requested_at: new Date().toISOString(), pdf_made_at: null,
  }).eq("id", reportId);
}

/** What the office PC's helper should turn into PDFs now. */
export async function pdfQueue(admin: SupabaseClient) {
  // the checked copy is in "Checked (dashboard)" inside the report folder; the PDF goes in the report folder itself
  const { data } = await admin.from("reports").select("id,main_folder,project_folder_name,folder_name,checked_name,pdf_name").eq("status", "approved").is("pdf_made_at", null).not("pdf_requested_at", "is", null).order("pdf_requested_at").limit(10);
  return (data ?? []).map((r) => ({ id: r.id, main_folder: r.main_folder, project_folder: r.project_folder_name, report_folder: r.folder_name, checked_folder: CHECKED_FOLDER, file_name: r.checked_name, pdf_name: r.pdf_name }));
}

/** The helper has saved the PDF (or couldn't): send it as soon as it's in Drive. */
export async function pdfMade(admin: SupabaseClient, reportId: string, error?: string | null) {
  if (error) {
    await admin.from("reports").update({ status: "ready", error: `The office PC couldn't make the PDF in Word: ${error.slice(0, 300)}`, pdf_requested_at: null }).eq("id", reportId);
    return false;
  }
  await admin.from("reports").update({ pdf_made_at: new Date().toISOString() }).eq("id", reportId);
  // Drive for desktop usually uploads it within a minute or two; give it up to ~90 seconds here, the 5-minute job does the rest
  for (let k = 0; k < 6; k++) {
    if (await sendIfPdfReady(admin, reportId)) return true;
    await new Promise((res) => setTimeout(res, 15_000));
  }
  return false;
}

/** Every approved report whose PDF has been made: send the ones whose PDF has reached Drive. */
export async function sendReady(admin: SupabaseClient) {
  const { data } = await admin.from("reports").select("id").eq("status", "approved").not("pdf_made_at", "is", null);
  let sent = 0;
  for (const r of data ?? []) if (await sendIfPdfReady(admin, r.id).catch(() => false)) sent++;
  return sent;
}

async function sendIfPdfReady(admin: SupabaseClient, reportId: string) {
  const { data: rep } = await admin.from("reports").select("*").eq("id", reportId).single();
  if (!rep || rep.status !== "approved" || !rep.pdf_name || !rep.pending_email) return false;
  const g = await driveClient(admin);
  const q = `'${rep.folder_id}' in parents and name = '${String(rep.pdf_name).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and mimeType = 'application/pdf' and trashed = false`;
  const found = await g.json<{ files: { id: string; size?: string }[] }>("files", { q, fields: "files(id,size)", orderBy: "modifiedTime desc", pageSize: "1", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const pdfFile = found.files[0];
  if (!pdfFile || !Number(pdfFile.size)) return false; // not uploaded yet
  const m = rep.pending_email as { to: string[]; cc: string[]; subject: string; body: string; by: string; by_name: string | null };
  // claim it, so two runs can't send it twice
  const { data: claimed } = await admin.from("reports").update({ status: "sending" }).eq("id", reportId).eq("status", "approved").select("id");
  if (!claimed?.length) return false;
  try {
    const pdf = Buffer.from(await g.download(pdfFile.id));
    const sent = await sendReportEmail(admin, m.by, { to: m.to, cc: m.cc, subject: m.subject, body: m.body, fileName: rep.pdf_name, pdf });
    const at = new Date().toISOString();
    await admin.from("reports").update({ status: "sent", pdf_file_id: pdfFile.id, sent_at: at, done_at: at, sent_by: m.by, sent_to: m.to, sent_cc: m.cc, gmail_message_id: sent.id, pending_email: null, updated_at: at }).eq("id", reportId);
    if (rep.project_id) await admin.from("project_events").insert({ project_id: rep.project_id, source: "team", kind: "Report sent", who: m.by_name ?? sent.from, body: `${rep.pdf_name} sent from ${sent.from} to ${m.to.join(", ")}${m.cc.length ? `, cc ${m.cc.join(", ")}` : ""}` });
    // sent: the clerk's original goes to Drive's bin (restorable for 30 days) and the checked copy takes its place
    if (rep.checked_file_id && rep.checked_folder_id) {
      try {
        await g.binOriginalReport(rep.drive_file_id);
        await g.move(rep.checked_file_id, rep.checked_folder_id, rep.folder_id);
        await admin.from("reports").update({ original_trashed_at: new Date().toISOString(), file_name: rep.checked_name ?? rep.file_name }).eq("id", reportId);
      } catch (e) {
        await admin.from("reports").update({ error: `Sent, but tidying the folder didn't finish: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}` }).eq("id", reportId);
      }
    }
    return true;
  } catch (e) {
    await admin.from("reports").update({ status: "approved", error: `Not sent yet: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}` }).eq("id", reportId);
    throw e;
  }
}

/** The "Checked (dashboard)" folder inside a report folder, where the fixed copies go (made the first time). */
export const CHECKED_FOLDER = "Checked (dashboard)";
async function checkedFolderFor(g: Awaited<ReturnType<typeof driveClient>>, reportFolder: string) {
  const found = await g.json<{ files: { id: string }[] }>("files", { q: `'${reportFolder}' in parents and name = '${CHECKED_FOLDER}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, fields: "files(id)", pageSize: "1", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  if (found.files[0]) return found.files[0].id;
  return (await g.post<{ id: string }>("https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true", { name: CHECKED_FOLDER, mimeType: "application/vnd.google-apps.folder", parents: [reportFolder] })).id;
}
