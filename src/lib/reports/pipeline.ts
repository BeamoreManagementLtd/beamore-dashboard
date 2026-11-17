import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { driveClient } from "@/lib/google";
import { visitDateFor } from "./visit-date.mjs";
import { projectMatcher } from "@/lib/project-match";
import { sendReportEmail } from "@/lib/google-user";
import { readReport, photoStats, shrinkPhotos, trackSpelling, saveReport, setLabelValue, nearText, photoHashes, reusedCount, uncaptioned, unticked, rotatePhoto, fixPhotoShapes, uniformPhotos, healthSafety, issuesTracker, trackerItems, cleanCopy, acceptOwnRevisions, withoutOwnMarks } from "./docx.mjs";
import { isMonthly, lastDiaryOfMonth, compareTrackers, trackerGapText } from "./monthly";
import { recordReportFiles } from "./tracker";
import { clerkForName } from "./clerk-name";

/** 0-100: how much the report needed fixing (must-checks count most). Lateness is shown separately. */
/**
 * 0-100: how much the report needed fixing. Everything the dashboard had to put right counts (Ronan, 15 Nov 2026),
 * not just what's left for the team: issues, spelling, the file name, mixed photo sizes, sideways, stretched or
 * oversized photos.
 */
export function qualityScore(issues: { severity: string }[], spelling: number, lateDays: number, f: { renamed?: boolean; mixedPhotos?: boolean; rotated?: number; stretched?: number; oversized?: boolean; standardsMissed?: number } = {}) {
  const w = { high: 15, medium: 6, low: 2 } as Record<string, number>;
  const off = issues.reduce((n, i) => n + (w[i.severity] ?? 0), 0) + Math.min(10, spelling) + Math.min(15, lateDays * 5)
    + (f.renamed ? 5 : 0) + (f.mixedPhotos ? 5 : 0) + Math.min(9, (f.rotated ?? 0) * 3) + Math.min(6, (f.stretched ?? 0) * 2) + (f.oversized ? 3 : 0)
    // each of the team's best practices not met (standards.ts)
    + 2 * (f.standardsMissed ?? 0);
  return Math.max(0, 100 - off);
}
import { checkReport, type Issue, type Programme } from "./check";
import { scoreParts, scoreTotal } from "./score";
import { STANDARDS, STANDARD_KEYS } from "./standards";

/**
 * Is this a genuine spelling/grammar slip (safe to correct automatically)? Each word that changes must stay close to
 * the original (edit distance at most a third of its length, at least 1-2 letters), so typos, doubled words, capitals
 * and punctuation pass, and swapping one word or name for another doesn't.
 */
const GRAMMAR_SWAPS = [["was", "were"], ["is", "are"], ["has", "have"], ["their", "there", "theyre", "they"], ["its", "it"], ["to", "too", "two"], ["then", "than"], ["your", "youre"], ["whose", "whos"], ["affect", "effect"], ["a", "an"], ["this", "these"], ["that", "those"], ["does", "do"], ["did", "done"]].map((g) => new Set(g));
export function isSpellingSlip(find: string, replace: string) {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const a = norm(find), b = norm(replace);
  if (!a.length || !b.length) return true; // punctuation or spacing only
  const dist = (x: string, y: string) => {
    const d = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
    for (let j = 1; j <= y.length; j++) d[0][j] = j;
    for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    return d[x.length][y.length];
  };
  // doubled or missing small word ("the the", "a"): the words otherwise match
  const shortA = a.filter((w) => w.length > 3), shortB = b.filter((w) => w.length > 3);
  if (shortA.join(" ") === shortB.join(" ")) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const joinedA = a.join(""), joinedB = b.join("");
  if (joinedA === joinedB) return true; // "car park" / "carpark"
  // words run together or split with a typo ("though out" -> "throughout", "issue's forseen" -> "issues foreseen")
  if (Math.abs(a.length - b.length) <= 1 && dist(joinedA, joinedB) <= Math.max(1, Math.floor(joinedB.length / 6))) return true;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    if (GRAMMAR_SWAPS.some((g) => g.has(a[i]) && g.has(b[i]))) continue;
    const allowed = Math.max(2, Math.floor(Math.max(a[i].length, b[i].length) / 3));
    if (dist(a[i], b[i]) > allowed) return false;
  }
  return true;
}

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
    p.items < 8 ? (p.items ? `only ${p.items} activit${p.items === 1 ? "y" : "ies"} listed (aim for 8-10, preferably on the critical path)` : "list 8-10 activities from the programme, preferably on the critical path") : "",
    !p.per_item_weeks ? 'say how many weeks ahead or behind each activity is, e.g. "Installation of staircases – 3 weeks behind"' : "",
    !p.critical_path ? "include activities on the critical path" : "",
    !p.narrative ? "add at least 5-6 lines weighing up all the items, the causes, and where you think the project is" : "",
    !p.overall_weeks ? 'give your overall view in weeks, e.g. "I estimate the contractor is 3.5 weeks behind programme"' : "",
    p.looks_from_site_team ? "give your own independent view, not the site team's figures" : "",
  ].filter(Boolean);
}
import { conventionName } from "./naming.mjs";
import { templateBits, compareTemplate, templateIssues, templatePoint, pickLast, type TemplateCheck } from "@/lib/reports/template";

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
/** The box in the report for the date it goes to the TA (DfE diaries / site visit reports), most specific first. */
const TA_DATE_LABELS = ["Date issued to Lead Consultant (TA)", "Date issued to Lead Consultant", "Date issued to TA", "Date issued to the TA", "Date sent to TA", "Issue Date", "Date of issue", "Date issued"];
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
    // new by when it arrived too: a file copied or moved into Drive keeps an older "modified" date (17 Nov 2026: ten
    // reports on the old Ready To Check sheet were missed that way); old .doc files are listed so nobody misses them
    listAll(g, `(mimeType='${DOCX}' or mimeType='application/msword') and trashed=false and (modifiedTime > '${since}' or createdTime > '${since}')`),
    listAll(g, `mimeType='application/pdf' and trashed=false and modifiedTime > '${pdfSince}'`),
  ]);

  // every report file that's arrived, Word or PDF, for the report tracker (some clerks upload PDFs only)
  await recordReportFiles(admin, g, [...docs, ...pdfs.filter((p) => p.createdTime >= since)]).catch(() => 0);

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
  // (old-style copies in "Checked (dashboard)"; a report checked in place is its own file and is still scanned)
  const copies = new Set(((await admin.from("reports").select("checked_file_id,drive_file_id").not("checked_file_id", "is", null)).data ?? []).filter((x) => x.checked_file_id !== x.drive_file_id).map((x) => x.checked_file_id as string));
  let found = 0;
  for (const f of docs) {
    if (f.name.startsWith("~$") || copies.has(f.id)) continue;
    const rf = await folder(f.parents?.[0]);
    if (!rf || !REPORT_FOLDER.test(rf.name.trim())) continue;
    const inner = await folder(rf.parents?.[0]);
    if (!inner) continue;
    // a job split into phases has one more level: Schools / The Royal School / Project 1 / Diaries (17 Nov 2026)
    let outer: Folder | null = null;
    if (!MAIN_FOLDERS.has(inner.parents?.[0] ?? "")) {
      const o = await folder(inner.parents?.[0]);
      if (!o || !MAIN_FOLDERS.has(o.parents?.[0] ?? "")) continue;
      outer = o;
    }
    // the job folder as the office PC's path needs it ("The Royal School\Project 1"), its id, and the Schools / Others folder
    const pf = { id: inner.id, name: outer ? `${outer.name}\\${inner.name}` : inner.name, parents: (outer ?? inner).parents };
    const phase = outer ? inner.name.replace(/^project\s*/i, "").trim() : "";
    const p = byFolder.get(inner.id)
      ?? (projects ?? []).find((x) => x.id === match.fromReference(outer ? `${outer.name} ${phase}` : inner.name))
      ?? (outer ? (projects ?? []).find((x) => x.id === match.fromReference(`${outer.name} ${inner.name}`)) : undefined);
    const kind = /m&e|mep/i.test(rf.name) ? "me" : "building";
    const { data: existing } = await admin.from("reports").select("id,status,checked_at").eq("drive_file_id", f.id).maybeSingle();
    if (existing) {
      // the clerk changed their original after it was checked: say so (the checked copy may be out of date)
      // (the checker's own changes in Word count too, so this only says so, worded for both)
      const changedAfter = existing.checked_at && Date.parse(f.modifiedTime) > Date.parse(existing.checked_at) + 5 * 60_000 && ["ready", "failed"].includes(existing.status);
      // folder names kept current too: a folder renamed in Drive (e.g. "MEP Diaries" to "M&E Diaries") would send the Word helper
      // to a path that no longer exists (16 Nov 2026)
      await admin.from("reports").update({ file_name: f.name, folder_id: rf.id, folder_name: rf.name.trim(), project_folder_id: pf.id, project_folder_name: pf.name, modified_at: f.modifiedTime, ...(changedAfter ? { error: "The report has been changed since it was checked (by the clerk, or in Word here). If the clerk has sent a new version, Check again: the new version is checked, keeping any changes made in Word." } : {}) }).eq("id", existing.id);
      continue;
    }
    // the visit date from its name, or the diary (replaced by the date written in the report once it's checked)
    const diary = p ? (await admin.from("diary_visits").select("visit_date,clerk_id,kind").eq("project_id", p.id).gte("visit_date", new Date(Date.parse(f.createdTime) - 60 * 864e5).toISOString().slice(0, 10))).data ?? [] : [];
    const clerkFor = p ? (kind === "me" ? p.clerk_me_id ?? p.clerk_id : p.clerk_id) : null;
    const theirs = diary.filter((v) => v.clerk_id === clerkFor || v.kind === (kind === "me" ? "me" : "building"));
    const vd = visitDateFor({ file_name: f.name, uploaded_at: f.createdTime }, (theirs.length ? theirs : diary).map((v) => v.visit_date as string));
    await admin.from("reports").insert({
      drive_file_id: f.id, file_name: f.name, folder_id: rf.id, folder_name: rf.name.trim(), project_folder_id: pf.id, project_folder_name: pf.name,
      ...vd,
      project_id: p?.id ?? null, kind, clerk_id: p ? (kind === "me" ? p.clerk_me_id ?? p.clerk_id : p.clerk_id) : null,
      uploaded_at: f.createdTime, modified_at: f.modifiedTime, main_folder: MAIN_FOLDER_NAME[pf.parents?.[0] ?? ""] ?? null,
      checker_id: p?.report_checker_id ?? byFirst((oldQueue ?? []).find((q) => q.project_id === p?.id && q.checker && q.checker !== "Unknown")?.checker),
      // an old-format Word file can't be checked automatically: it waits for the team to check it by hand
      ...(/\.doc$/i.test(f.name) ? { status: "failed", error: "Old Word format (.doc): the dashboard can't check it. Open it in Word, check it by hand and save it as .docx (or make the PDF as before)." } : {}),
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
  // a job's checker given by email (Judy, before she'd signed in, 17 Nov 2026): their login once they have one
  const { data: byEmail } = await admin.from("projects").select("id,report_checker_email").not("report_checker_email", "is", null).is("report_checker_id", null);
  for (const p of byEmail ?? []) {
    const s = (staff ?? []).find((x) => (x.email ?? "").toLowerCase() === String(p.report_checker_email).toLowerCase());
    if (!s) continue;
    await admin.from("projects").update({ report_checker_id: s.id }).eq("id", p.id);
    const pr = (projects ?? []).find((x) => x.id === p.id); if (pr) pr.report_checker_id = s.id;
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
  // the check works on the clerk's own file, in its own folder (Ronan, 16 Nov 2026: no separate copy for the office to
  // find). The version the clerk uploaded is kept for good in Drive's version history, and a "Check again" starts from
  // it, unless the file has been changed since the dashboard last saved it (a new version from the clerk, or the
  // checker's own changes in Word), in which case that newer version is checked, with the earlier marks taken out first.
  const untouched = rep.original_revision_id && rep.checked_revision && meta.headRevisionId === rep.checked_revision;
  const sourceRev = untouched ? rep.original_revision_id as string : meta.headRevisionId;
  let raw = Buffer.from(untouched ? await g.downloadRevision(rep.drive_file_id, sourceRev) : await g.download(rep.drive_file_id));
  if (!untouched && rep.checked_revision) raw = Buffer.from(await withoutOwnMarks(raw));
  if (!untouched) await g.keepRevision(rep.drive_file_id, sourceRev).catch(() => undefined);
  const r = await readReport(raw);
  const stats = await photoStats(r, sharp);

  // what the check needs to know about the job
  const { data: p } = rep.project_id ? await admin.from("projects").select("id,name,dfe_project_number,po_number,clerk_id,clerk_me_id,details,clients(name)").eq("id", rep.project_id).single() : { data: null };
  // the client the report names may be the end client, not ours (Pepys Court: Diamond and Co are our client, Encore
  // Estates the end user, Ronan 17 Nov 2026): either is right, so neither is raised as a mix-up
  const ourClient = (p?.clients as unknown as { name?: string } | null)?.name ?? null;
  const endClient = ((p?.details ?? {}) as { end_client?: string }).end_client ?? null;
  const clerkIds = [p?.clerk_id, p?.clerk_me_id].filter(Boolean) as string[];
  const { data: clerks } = clerkIds.length ? await admin.from("clerks").select("id,name").in("id", clerkIds) : { data: [] };
  const since = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const { data: visits } = rep.project_id ? await admin.from("diary_visits").select("visit_date,side,clerks(name)").eq("project_id", rep.project_id).gte("visit_date", since).order("visit_date") : { data: [] };
  void [...new Set((visits ?? []).map((v) => `${v.visit_date} ${(v.clerks as unknown as { name?: string } | null)?.name ?? ""}${v.side === "planned" ? " (planned)" : ""}`.trim()))];
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

  // was it started from last week's checked report, with the office's changes kept? (Ronan, 16 Nov 2026)
  let template: TemplateCheck | null = null;
  if (rep.project_id) {
    try {
      const { data: older } = await admin.from("reports").select("id,file_name,folder_name,report_number,drive_file_id,original_revision_id").eq("project_id", rep.project_id).eq("kind", rep.kind).neq("id", id).lt("uploaded_at", rep.uploaded_at).order("uploaded_at", { ascending: false }).limit(8);
      const [last, before] = pickLast(rep, older ?? []);
      if (last) {
        const lastBits = await templateBits(await g.download(last.drive_file_id));
        const asSent = last.original_revision_id ? await templateBits(await g.downloadRevision(last.drive_file_id, last.original_revision_id)).catch(() => null) : null;
        const beforeBits = before ? await templateBits(await g.download(before.drive_file_id)).catch(() => null) : null;
        template = compareTemplate(await templateBits(raw), lastBits, asSent, beforeBits, { id: last.id, number: last.report_number, name: last.file_name });
      }
    } catch { template = null; /* a check that can't be done is left out, never holds the report up */ }
  }

  // the report's appendix, if the clerk keeps one as a separate PDF beside it with the same report number ("151. ...
  // St Michael's appendix. field-note-report....pdf" for "151- ...CoWDiary 11.11.26.docx"): read together with it
  let appendix: { name: string; pdf: Buffer } | null = null;
  try {
    const num = /^\s*0*(\d{1,4})(?!\d)/.exec(rep.renamed_from ?? rep.file_name)?.[1];
    if (num) {
      const near = await g.json<{ files: { id: string; name: string; size?: string; createdTime: string }[] }>("files", { q: `'${rep.folder_id}' in parents and trashed = false and mimeType = 'application/pdf' and name contains 'ppendi'`, fields: "files(id,name,size,createdTime)", orderBy: "createdTime desc", pageSize: "20", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      const a = near.files.find((f) => /^\s*0*(\d{1,4})(?!\d)/.exec(f.name)?.[1] === num && Number(f.size ?? 0) < 25_000_000);
      if (a) appendix = { name: a.name, pdf: Buffer.from(await g.download(a.id)) };
    }
  } catch { appendix = null; }

  const ai = await checkReport({
    fileName: rep.renamed_from ?? rep.file_name, folder: rep.folder_name ?? "", project: p?.name ?? rep.project_folder_name ?? "",
    client: ourClient && endClient ? `${ourClient} (Beamore's client), working for the end client ${endClient}: the report may name either as the client, and both are correct, so don't raise it` : ourClient,
    projectNumbers: [p?.dfe_project_number, p?.po_number].filter((x): x is string => !!x && /\d/.test(x)),
    // the diary's dates are only estimates for costing, so reports aren't checked against them (Ronan, 15 Nov 2026)
    expectedClerks: (clerks ?? []).map((c) => c.name), diaryVisits: [],
    previous: prev ? { number: prev.report_number, date: prev.visit_date, text: prev.text_snapshot ?? "" } : null,
    paragraphs: r.paragraphs, blanks: r.blanks, placeholders: r.placeholders,
    photos: { count: stats.count, blurry: stats.blurry, smallOnPage: stats.smallOnPage, stretched: stats.stretched, mb: raw.length / 1e6, usual, reused, uncaptioned: uncaptioned(r) },
    unticked: unticked(r), thumbnails: thumbs, today: new Date().toISOString().slice(0, 10), appendix,
  });

  // first: the file name follows the pattern of the other reports in its folder (next number, this visit's date)
  const visitDate = ai.visit_date && /^\d{4}-\d{2}-\d{2}$/.test(ai.visit_date) ? ai.visit_date : null;
  let renamedTo: string | null = null;
  try {
    const sibs = await g.json<{ files: { name: string }[] }>("files", { q: `'${rep.folder_id}' in parents and trashed = false and (mimeType = '${DOCX}' or mimeType = 'application/pdf')`, fields: "files(name)", orderBy: "modifiedTime desc", pageSize: "40", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const want = conventionName(rep.file_name, sibs.files.map((f) => f.name).filter((n) => n !== rep.file_name), visitDate, ai.report_number);
    if (want && !sibs.files.some((f) => f.name.toLowerCase() === want.toLowerCase())) renamedTo = want;
  } catch { /* keep the name */ }
  // checked again after the dashboard already renamed it: still counts as a name that needed putting right
  const nameFixed = renamedTo ?? (rep.renamed_from ? rep.file_name as string : null);

  // put the fixes into the Word file: spelling, grammar and punctuation as tracked changes, photos turned upright, all
  // the same size (Christian's: 6 cm squares) and made smaller, issues as comments
  // photos aren't turned automatically any more: from small samples the AI turned portrait photos sideways (Peter
  // Lord, King's Maths School, 15 Nov 2026). Ones that look sideways are pointed out for the checker instead.
  const rotated: string[] = [];
  const sideways = [...new Set((ai.rotate ?? []).map((t) => thumbPaths[t.photo - 1]).filter(Boolean))];
  void rotatePhoto;
  // blank boxes are left for the clerk (Ronan, 15 Nov 2026); photo shapes and sizes are put right
  // every photo the same size (Christian's format); where that can't apply, at least stretched/tiny photos put right
  const uniform = uniformPhotos(r, await photoStats(r, sharp), await r.zip.file("word/_rels/document.xml.rels")!.async("string"));
  const shapes = uniform.changed ? { stretched: 0, enlarged: 0 } : await fixPhotoShapes(r, await photoStats(r, sharp));
  const shrunk = await shrinkPhotos(r, sharp, await photoStats(r, sharp));
  // spelling is fixed automatically but kept as tracked changes, so the checker and the clerk can see every mistake,
  // and each one is counted to see whether a clerk is improving (Ronan, 16 Nov 2026)
  // only real spelling slips: the AI once "corrected" Swift cladding to Swisspearl cladding (16 Nov 2026), so a fix
  // must stay close to what was written (a typo, doubled word, capital, punctuation), never a different word
  const heldBack = (ai.spelling ?? []).filter((s) => !isSpellingSlip(s.find, s.replace));
  ai.spelling = (ai.spelling ?? []).filter((s) => isSpellingSlip(s.find, s.replace));
  const spelt = trackSpelling(r, ai.spelling);
  void acceptOwnRevisions;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  // not enough photos or not enough written, against the benchmark clerks' reports (weekly diaries: 35-57 photos,
  // 1,800-5,000 words); monthly reports aren't judged on this
  const words = r.paragraphs.reduce((n, p) => n + (p.text.match(/[A-Za-z]{2,}/g) ?? []).length, 0);
  const monthly = isMonthly(rep);
  const min = rep.kind === "me" ? { photos: 12, words: 800 } : { photos: 20, words: 1200 };
  const extra: Issue[] = [];
  // with an appendix, the photos and much of the writing are in it (Tom Hunt's St Michael's reports)
  if (!monthly && !appendix && stats.count < min.photos) extra.push({ severity: "medium", kind: "photos", text: `Only ${stats.count} photo${stats.count === 1 ? "" : "s"}: good reports have ${rep.kind === "me" ? "20 or more" : "35-50"}${usual ? ` (this clerk usually has about ${usual} here)` : ""}`, p: null });
  if (!monthly && !appendix && words < min.words) extra.push({ severity: "medium", kind: "vague", text: `Not much written (about ${words} words): good reports describe each area in detail, typically ${rep.kind === "me" ? "1,000+" : "1,800-5,000"} words`, p: null });
  // progress vs programme, the Beamore way (Ronan's "Site Diaries" email, Aug 2024): raised even if the AI didn't list it
  const prog = ai.programme;
  const progGaps = programmeGaps(prog);
  if (prog && prog.verdict !== "good" && prog.verdict !== "not_in_form" && !ai.issues.some((i) => i.kind === "programme"))
    extra.push({ severity: prog.verdict === "missing" && prog.dfe ? "high" : "medium", kind: "programme", text: `${prog.dfe ? "Progress vs programme" : "Progress summary"} ${prog.verdict === "missing" ? "not done" : "falls short"}: ${progGaps.join("; ") || prog.note}`, p: prog.p });
  // the ten H&S items at the start of the report: none deleted or left empty, and properly filled in (Ronan, 15 Nov
  // 2026). Not held against the first couple of reports on a job, when there may genuinely be little to say.
  const onDfeForm = prog?.dfe ?? /\bDfE\b|CQM|TAS20/i.test(r.paragraphs.slice(0, 60).map((p) => p.text).join(" "));
  // the DfE form doesn't generally let clerks put a progress summary up front (Ronan, 17 Nov 2026: "you're marking
  // people down unnecessarily"), so on DfE reports it isn't counted, raised or suggested; reports checked before stay
  // as they were
  if (onDfeForm) {
    if (ai.standards) delete (ai.standards as Record<string, unknown>).summary;
    const upFront = /\b(progress )?summary\b.{0,40}\b(up front|at the (start|top|beginning)|open(s|ing)? with)\b|\bopen(s|ing)? with (a|an|the) (short |clear |brief )?(progress )?summary\b/i;
    ai.issues = ai.issues.filter((i) => !upFront.test(i.text));
    ai.clerk_points = (ai.clerk_points ?? []).filter((t) => !upFront.test(t));
  }
  const hs = healthSafety(r, onDfeForm);
  // the DfE CQM monthly report has a written H&S section rather than the ten rows, so it isn't checked this way
  const cqm = /CQM|Construction Quality\s+Monitoring/i.test(r.paragraphs.slice(0, 40).map((p) => p.text).join(" "));
  // the ten H&S rows are only looked for in the Word file: with an appendix they may be written there instead
  const early = cqm || !!appendix || Number(/\d+/.exec(ai.report_number ?? "")?.[0] ?? 99) <= 2;
  const hsGone = hs.filter((h) => h.status === "missing" || h.status === "empty"), hsThin = hs.filter((h) => h.status === "thin");
  if (!early && hsGone.length) extra.push({ severity: hsGone.length >= 5 ? "high" : "medium", kind: "other", text: `Health and safety: ${hs.length - hsGone.length - hsThin.length} of the ${hs.length} standard items filled in properly. ${hsGone.map((h) => `${h.label} ${h.status === "missing" ? "deleted" : "left empty"}`).join("; ")}${hsThin.length ? `; only "N/A"/"none" for ${hsThin.map((h) => h.label).join(", ")}` : ""}`, p: null });
  else if (!early && hsThin.length >= 3) extra.push({ severity: "low", kind: "other", text: `Health and safety: only "N/A"/"none" for ${hsThin.map((h) => h.label).join(", ")}`, p: null });
  // the issues tracker: no photos in it, every item red/orange/green, closed items dated, green and explained
  const trk = issuesTracker(r);
  // the tracker kept as its own spreadsheet or PDF beside the report (Ronan, 17 Nov 2026: Damian's Excel tracker), updated
  // in the last three weeks: it counts as the report's tracker (its contents aren't checked)
  let trackerFile: string | null = null;
  if (!trk.tables) {
    try {
      const since = new Date(Date.now() - 21 * 864e5).toISOString();
      const tf = await g.json<{ files: { name: string }[] }>("files", { q: `'${rep.folder_id}' in parents and trashed = false and modifiedTime > '${since}' and (name contains 'racker' or name contains 'efect' or name contains 'ssues log') and (mimeType = 'application/pdf' or mimeType contains 'spreadsheet' or mimeType contains 'excel')`, fields: "files(name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      trackerFile = tf.files[0]?.name ?? null;
    } catch { trackerFile = null; }
    if (trackerFile) {
      if (ai.standards) (ai.standards as Record<string, boolean>).tracker = true;
      ai.issues = ai.issues.filter((i) => !/\b(no|missing|without (a|an))\b.{0,30}\b(issues?|defects?) (tracker|log)\b/i.test(i.text));
    }
  }
  const nums = (a: string[]) => `${a.slice(0, 8).join(", ")}${a.length > 8 ? ` and ${a.length - 8} more` : ""}`;
  const trkProblems = [
    trk.photos ? `${trk.photos} photo${trk.photos === 1 ? "" : "s"} in the tracker (it should just record the issue and which report it's in)` : "",
    trk.uncoloured.length ? `item${trk.uncoloured.length === 1 ? "" : "s"} ${nums(trk.uncoloured)} not coloured red, orange or green` : "",
    trk.greenNoDate.length ? `item${trk.greenNoDate.length === 1 ? "" : "s"} ${nums(trk.greenNoDate)} green but with no date closed` : "",
    trk.closedNotGreen.length ? `item${trk.closedNotGreen.length === 1 ? "" : "s"} ${nums(trk.closedNotGreen)} closed but not turned green` : "",
    trk.closedNoReason.length ? `item${trk.closedNoReason.length === 1 ? "" : "s"} ${nums(trk.closedNoReason)} closed without a comment saying why` : "",
    // an old progress note left in place of the reason for closing (Ronan, 15 Nov 2026)
    trk.closedReasonUnclear.length ? `item${trk.closedReasonUnclear.length === 1 ? "" : "s"} ${nums(trk.closedReasonUnclear)} closed, but the comment doesn't say why (e.g. ${trk.unclearExamples[0] ? `item ${trk.unclearExamples[0].no}: "${trk.unclearExamples[0].comment}"` : ""})` : "",
  ].filter(Boolean);
  if (trkProblems.length) extra.push({ severity: "medium", kind: "other", text: `Issues tracker: ${trkProblems.join("; ")}`, p: null });
  // a monthly report's tracker brought up to date with the last weekly diary of the month (Ronan, 17 Nov 2026)
  let monthlyTracker: { against: string; month: string; missing: string[]; behind: string[]; text: string | null; details: { no: string; item: string; why: "missing" | "behind"; closed: string }[] } | null = null;
  if (monthly) {
    try {
      const last = await lastDiaryOfMonth(admin, { id, project_id: rep.project_id, kind: rep.kind, file_name: rep.renamed_from ?? rep.file_name, uploaded_at: rep.uploaded_at });
      if (last) {
        const gap = compareTrackers(trackerItems(r), trackerItems(await readReport(Buffer.from(await g.download(last.drive_file_id)))), r.paragraphs.map((x) => x.text));
        const text = trackerGapText(gap, last.file_name);
        monthlyTracker = { against: last.file_name, month: last.month, missing: gap.missing, behind: gap.behind, text, details: gap.details };
        if (text) extra.push({ severity: "medium", kind: "other", text, p: null });
      }
    } catch { /* a check that can't be done is left out, never holds the report up */ }
  }
  if (sideways.length) extra.push({ severity: "low", kind: "photos", text: `${sideways.length} photo${sideways.length === 1 ? "" : "s"} may be on ${sideways.length === 1 ? "its" : "their"} side: please check and turn by hand if so (not changed automatically)`, p: null });
  // the date issued to the Lead Consultant is filled in by the office when it's sent (Ronan, 15 Nov 2026)
  const notOurs = (i: Issue) => /date issued to (the )?lead consultant|issued to lead consultant/i.test(i.text) || (i.kind === "photos" && /caption/i.test(i.text) && !/fewer|only \d+ photo/i.test(i.text)) || /beamore'?s diary|in the diary for this job|diary (says|shows)/i.test(i.text);
  const issues: Issue[] = [...extra, ...ai.issues.filter((i) => !notOurs(i))].sort((a, b) => rank[a.severity] - rank[b.severity]);
  if (spelt.skipped.length) issues.push({ severity: "low", kind: "other", text: `Spelling not changed automatically (please fix by hand): ${spelt.skipped.slice(0, 8).map((s) => `${s.find} → ${s.replace}`).join(", ")}`, p: null });
  // suggested rewordings that change more than spelling: left for the checker to decide, never made automatically
  if (heldBack.length) issues.push({ severity: "low", kind: "other", text: `Suggested wording changes, not made (check and change by hand only if right): ${heldBack.slice(0, 8).map((s) => `"${s.find}" → "${s.replace}"`).join("; ")}`, p: heldBack[0]?.p ?? null });
  // the points are listed on the dashboard with their page number, not put in the Word file as comments (Ronan, 16 Nov
  // 2026): a few words from each place are kept, and the office PC's Word helper looks up the page they fall on
  if (template) for (const t of templateIssues(template)) issues.push({ ...t, kind: "template", p: null });
  for (const i of issues) i.near = nearText(r, i.p);
  const out = await saveReport(r);

  // only if the clerk hasn't changed it while we were checking
  const now = await g.json<{ headRevisionId: string }>(`files/${rep.drive_file_id}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  if (now.headRevisionId !== meta.headRevisionId) {
    // another check of the same report (the 15-minute job and a manual run together) has just saved it: that one stands
    const { data: latest } = await admin.from("reports").select("checked_revision,status").eq("id", id).single();
    if (latest?.checked_revision === now.headRevisionId) {
      if (latest.status !== "ready") await admin.from("reports").update({ status: "ready" }).eq("id", id);
      return;
    }
    await admin.from("reports").update({ status: "new", modified_at: new Date().toISOString() }).eq("id", id);
    return;
  }
  // the checked version is saved over the clerk's own file, where it is, and renamed to the folder's pattern (Ronan,
  // 16 Nov 2026). A copy in "Checked (dashboard)" from before then is put in the bin: this replaces it.
  // characters Windows can't have in a file name (e.g. "09:11:26") become dots, or the file never reaches the office PC
  // and Word can't make its PDF (16 Nov 2026)
  const checkedName = (renamedTo ?? (rep.checked_name && rep.checked_file_id === rep.drive_file_id ? rep.checked_name : rep.file_name)).replace(/[:*?"<>|]/g, ".");
  await g.replaceContent(rep.drive_file_id, out, DOCX);
  if (checkedName !== rep.file_name) await g.rename(rep.drive_file_id, checkedName).catch(() => undefined);
  if (rep.checked_file_id && rep.checked_file_id !== rep.drive_file_id) await g.binOriginalReport(rep.checked_file_id).catch(() => undefined);
  const after = await g.json<{ headRevisionId: string }>(`files/${rep.drive_file_id}`, { fields: "headRevisionId", supportsAllDrives: "true" });
  await admin.from("reports").update({
    checked_file_id: rep.drive_file_id, checked_folder_id: rep.folder_id, checked_name: checkedName, file_name: checkedName,
    original_revision_id: sourceRev, renamed_from: checkedName !== rep.file_name ? rep.file_name : rep.renamed_from ?? null,
  }).eq("id", id);
  const visitFromName = /(\d{1,2})[.\-_ ](\d{1,2})[.\-_ ](\d{2,4})/.exec(rep.file_name);
  const nameDate = visitFromName ? `${visitFromName[3].length === 2 ? `20${visitFromName[3]}` : visitFromName[3]}-${visitFromName[2].padStart(2, "0")}-${visitFromName[1].padStart(2, "0")}` : null;
  const applied = ai.spelling.filter((s) => !spelt.skipped.includes(s)).map((s) => ({ find: s.find, replace: s.replace }));
  // the report's mark, from the report as the clerk sent it, before any corrections (Ronan, 16 Nov 2026)
  const parts = scoreParts({
    quality: Number.isFinite(ai.quality) ? ai.quality : null, qualityWhy: ai.quality_why || null,
    photos: { count: stats.count, expected: monthly || appendix ? 0 : rep.kind === "me" ? 20 : 35, mixed: !uniform.wasUniform, stretched: stats.stretched, small: stats.smallOnPage, blurry: stats.blurry, sideways: sideways.length, reused },
    spelling: ai.spelling.length, spellingExamples: ai.spelling.slice(0, 4).map((s) => `"${s.find}" → "${s.replace}"`), words,
    hs: early ? null : hs, programme: prog ?? null, programmeGaps: progGaps.length, programmeTips: progGaps, standards: ai.standards ?? null,
    standardsMissed: STANDARD_KEYS.filter((k) => ai.standards?.[k] === false).map((k) => STANDARDS[k].label),
    tracker: trk.tables ? trkProblems.length : trackerFile ? 0 : null, trackerProblems: trkProblems, trackerExpected: !early, renamed: !!nameFixed, renamedTo: nameFixed,
  });
  await admin.from("reports").update({
    status: "ready", ai_summary: ai.summary, issues, spelling_fixed: spelt.applied,
    photos: { count: stats.count, blurry: stats.blurry, smallOnPage: stats.smallOnPage, stretched: stats.stretched, shrunk: shrunk.changed, rotated: rotated.length, reused, usual, uncaptioned: uncaptioned(r) },
    photo_hashes: hashes, photo_count: stats.count,
    fixes: { spelling: applied, rotated: rotated.length, shrunk: shrunk.changed, stretched: shapes.stretched, enlarged: shapes.enlarged, uniform: uniform.changed, mixed: !uniform.wasUniform, side_cm: uniform.side ? +(uniform.side / 360000).toFixed(1) : null, renamed: nameFixed, words, programme: prog ?? null, standards: ai.standards ?? null, health_safety: hs, tracker: trk, monthly_tracker: monthlyTracker,
      score_by: "parts", score_parts: parts, template, pages_state: issues.some((i) => i.near) ? "waiting" : "none" },
    // lateness is shown on its own on the Reports page
    score: scoreTotal(parts),
    clerk_points: [
      // worded as friendly suggestions, not orders (Ronan, 15 Nov 2026: "steer them in the right direction")
      ...(nameFixed ? [`If you could name the file the same way as the others in the folder, e.g. "${nameFixed.replace(/\.docx?$/i, "")}", it keeps everything easy to find`] : []),
      ...(!uniform.wasUniform ? ["Keeping all the photos the same size (about 6 cm wide: 6 x 4.5 cm landscape, 4.5 x 6 cm portrait, two to a line) makes the report look really tidy"] : []),
      ...(rotated.length ? ["A quick check that photos are the right way up before inserting them would help"] : []),
      ...(stats.stretched ? ["A handy tip: resizing photos from a corner (or holding Shift) stops them stretching out of shape"] : []),
      ...(raw.length > 10_000_000 ? [`The file came in at ${(raw.length / 1e6).toFixed(0)} MB, so it's worth shrinking the photos before inserting them (in Word: Picture Format > Compress Pictures)`] : []),
      ...(!early && (hsGone.length || hsThin.length >= 3) ? [`It would be great to see all ${hs.length} health and safety items at the start of the report filled in, even briefly, rather than taken out or left as "N/A". This time it was ${hs.filter((h) => h.status !== "ok").map((h) => h.label).join(", ")}`] : []),
      ...(trkProblems.length ? [`On the issues tracker: it works best as a simple record of each issue and which report to read about it in (so no photos), with every item red, orange or green. When you close one, add the date, turn it green and add a line in the comments saying why it's closed, e.g. "certificate received 12/11/26" or "remedial work seen complete on 12/11/26", rather than leaving the earlier progress note as the last word`] : []),
      ...(monthlyTracker?.text ? [`It would help to bring the monthly report's issues tracker up to date with the last diary of the month (${monthlyTracker.against.replace(/\.docx?$/i, "")}), so it shows the same open and closed items`] : []),
      ...(prog && (prog.verdict === "weak" || prog.verdict === "missing") ? [`On the ${prog.dfe ? "progress vs programme section" : "progress summary"}, it would help to ${progGaps.join("; ") || "follow the approach below"}`] : []),
      ...(template && templatePoint(template) ? [templatePoint(template)!] : []),
      ...(ai.clerk_points ?? []),
    ].slice(0, 8),
    size_before: raw.length, size_after: out.length, checked_revision: after.headRevisionId, checked_at: new Date().toISOString(),
    // the date written in the report wins; otherwise the one already worked out from its name or the diary stays
    ...(ai.visit_date && /^\d{4}-\d{2}-\d{2}$/.test(ai.visit_date) && rep.visit_date_source !== "manual" ? { visit_date: ai.visit_date, visit_date_source: "report" }
      : !rep.visit_date && nameDate && !Number.isNaN(Date.parse(nameDate)) ? { visit_date: nameDate, visit_date_source: "name" } : {}),
    report_number: ai.report_number, clerk_name: ai.clerk_name,
    // no clerk from the job: the one named in the report ("Antony Larkins" is Tony Larkins), so it's counted and linked
    ...(!rep.clerk_id && ai.clerk_name ? await (async () => { const { data: all } = await admin.from("clerks").select("id,name"); const c = clerkForName(ai.clerk_name, all ?? []); return c ? { clerk_id: c.id } : {}; })() : {}),
    text_snapshot: r.paragraphs.map((x) => x.text).filter((x) => x.trim()).join("\n").slice(0, 20000),
    modified_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("id", id);
  if (monthlyTracker?.text) await askToUpdateMonthlyTracker(admin, { id, clerk_id: rep.clerk_id, file_name: rep.file_name }, monthlyTracker).catch(() => undefined);
  if (ai.date_on_report === "none" || ai.date_on_report === "week_commencing")
    await askForVisitDates(admin, { id, clerk_id: rep.clerk_id, file_name: rep.file_name }, ai.date_on_report).catch(() => undefined);
}

/**
 * A report with no visit date written in it, or only "week commencing" (Ronan, 17 Nov 2026): email the clerk straight
 * away (from Ronan's Gmail, not a draft) asking for the date of each visit. Once per report, and no more than one a
 * week to the same clerk. Gentle, like all feedback to the clerks. Kept on "Emails to send" as a record.
 */
async function askForVisitDates(admin: SupabaseClient, rep: { id: string; clerk_id: string | null; file_name: string }, how: "none" | "week_commencing") {
  if (!rep.clerk_id) return;
  const { data: c } = await admin.from("clerks").select("name,email,active").eq("id", rep.clerk_id).single();
  if (!c?.email || !c.active) return;
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data: before } = await admin.from("email_outbox").select("id,ref,created_at").eq("kind", "report-visit-dates")
    .or(`ref.eq.${rep.id},and(clerk_id.eq.${rep.clerk_id},created_at.gte.${weekAgo})`).limit(1);
  if (before?.length) return;
  const first = c.name.split(" ")[0];
  const name = rep.file_name.replace(/\.docx?$/i, "");
  const body = `Hi ${first}\n\nThanks for your report (${name}). ${how === "week_commencing" ? "I noticed it gives the week (\"week commencing\") rather than the day you were on site." : "I couldn't see the date of the visit written in it."}\n\nCould you make sure each report has the date of each visit on it, near the top? If you were on site twice, please put both dates (for example 10/11/26 and 13/11/26), rather than week commencing.\n\nIt helps us match each report to the visit and keep on top of when reports go out.\n\nMany thanks\n\nRonan O'Boyle\nBeamore Management Ltd`;
  const subject = "The visit date on your reports";
  await (await driveClient(admin)).sendAutomatic({ to: c.email, subject, body });
  const { queueEmail } = await import("@/lib/outbox");
  await queueEmail(admin, { kind: "report-visit-dates", to: c.email, subject, body, clerkId: rep.clerk_id, ref: rep.id, status: "sent", note: "Sent automatically" });
}

/**
 * A monthly report whose issues tracker hasn't been brought up to date with the last weekly diary of the month (Ronan,
 * 17 Nov 2026: "write an email from my email address and just send it straight out ... if you need to query anything
 * with them, just do it"). Sent straight away from Ronan's Gmail, once per monthly report, gentle like all feedback to
 * the clerks, naming the items. Kept on "Emails to send" as a record.
 */
export async function askToUpdateMonthlyTracker(admin: SupabaseClient, rep: { id: string; clerk_id: string | null; file_name: string },
  t: { against: string; details: { no: string; item: string; why: "missing" | "behind"; closed: string }[] }) {
  if (!rep.clerk_id || !t.details.length) return false;
  const { data: c } = await admin.from("clerks").select("name,email,active").eq("id", rep.clerk_id).single();
  if (!c?.email || !c.active) return false;
  const { data: before } = await admin.from("email_outbox").select("id").eq("kind", "monthly-tracker").eq("ref", rep.id).limit(1);
  if (before?.length) return false;
  const short = (s: string) => (s.length > 90 ? `${s.slice(0, 87).replace(/\s+\S*$/, "")}...` : s);
  const missing = t.details.filter((d) => d.why === "missing"), behind = t.details.filter((d) => d.why === "behind");
  const lines = (a: typeof missing, f: (d: (typeof missing)[number]) => string) => `${a.slice(0, 12).map(f).join("\n")}${a.length > 12 ? `\n- and ${a.length - 12} more` : ""}`;
  const name = rep.file_name.replace(/\.docx?$/i, ""), diary = t.against.replace(/\.docx?$/i, "");
  const body = [
    `Hi ${c.name.split(" ")[0]}`,
    `Thanks for your monthly report (${name}). I was comparing its issues tracker with the one in your last diary of the month (${diary}), and they don't quite match yet.`,
    ...(missing.length ? [`These open items in the diary aren't in the monthly report:\n${lines(missing, (d) => `- ${d.no}: ${short(d.item)}`)}`] : []),
    ...(behind.length ? [`These are closed in the diary but still show as open in the monthly report:\n${lines(behind, (d) => `- ${d.no}: ${short(d.item)}${d.closed ? ` (closed ${d.closed})` : ""}`)}`] : []),
    `Could you bring the monthly report's tracker up to date with the diary and send me the updated version? If I've got any of this wrong, or there's a reason they differ, just let me know.`,
    `Many thanks\n\nRonan O'Boyle\nBeamore Management Ltd`,
  ].join("\n\n");
  const subject = `Issues tracker in your monthly report: ${name}`;
  await (await driveClient(admin)).sendAutomatic({ to: c.email, subject, body });
  const { queueEmail } = await import("@/lib/outbox");
  await queueEmail(admin, { kind: "monthly-tracker", to: c.email, subject, body, clerkId: rep.clerk_id, ref: rep.id, status: "sent", note: "Sent automatically" });
  return true;
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
  // the date it goes to the TA (Ronan, 17 Nov 2026): "Date issued to Lead Consultant (TA)" / "Issue Date" in the report
  // gets today's date, replacing any date already there. The office PC then needs a moment to get that version before
  // it makes the PDF, so the PDF is asked for 90 seconds later. If the box isn't found, nothing changes.
  const today = new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London" }); // dd/mm/yyyy
  let issued: string | null = null, rev: string | null = null;
  try {
    const g = await driveClient(admin);
    const r = await readReport(Buffer.from(await g.download(rep.checked_file_id)));
    if (setLabelValue(r, TA_DATE_LABELS, today)) {
      await g.replaceContent(rep.checked_file_id, await saveReport(r), DOCX);
      rev = (await g.json<{ headRevisionId: string }>(`files/${rep.checked_file_id}`, { fields: "headRevisionId", supportsAllDrives: "true" })).headRevisionId;
      issued = today.split("/").reverse().join("-");
    }
  } catch { /* the report still goes; the date just isn't filled in */ }
  await admin.from("reports").update({
    status: "approved", approved_by: who.id, approved_at: new Date().toISOString(), error: null,
    pending_email: { ...m, by: who.id, by_name: who.full_name }, pdf_name: pdfName, pdf_made_at: null,
    pdf_requested_at: new Date(Date.now() + (issued ? 90_000 : 0)).toISOString(),
    ...(issued ? { issued_on: issued, ...(rep.checked_file_id === rep.drive_file_id && rev ? { checked_revision: rev } : {}) } : {}),
  }).eq("id", reportId);
}

/** What the office PC's helper should turn into PDFs now. */
export async function pdfQueue(admin: SupabaseClient) {
  // the checked copy is in "Checked (dashboard)" inside the report folder; the PDF goes in the report folder itself
  // checked in place (from 16 Nov 2026): the Word file is in the report folder itself ("." keeps the helper's path joining)
  const { data } = await admin.from("reports").select("id,main_folder,project_folder_name,folder_name,checked_name,pdf_name,checked_file_id,drive_file_id,file_name").eq("status", "approved").is("pdf_made_at", null).not("pdf_requested_at", "is", null).lte("pdf_requested_at", new Date().toISOString()).order("pdf_requested_at").limit(10);
  // checked in place and renamed since (Anél renamed Preece House "69 - ..." to "74 - ..." before approving, 17 Nov 2026,
  // and the helper looked for the old name for hours): the file's name now in Drive, and the PDF named to match
  const g = (data ?? []).some((r) => r.checked_file_id === r.drive_file_id) ? await driveClient(admin).catch(() => null) : null;
  const out = [];
  for (const r of data ?? []) {
    let name = r.checked_name as string, pdf = r.pdf_name as string | null;
    if (g && r.checked_file_id === r.drive_file_id) {
      const now = await g.json<{ name?: string }>(`files/${r.drive_file_id}`, { fields: "name", supportsAllDrives: "true" }).then((f) => f.name ?? null).catch(() => null);
      if (now && now !== name) {
        const oldBase = name.replace(/\.docx?$/i, "");
        if (!pdf || pdf.replace(/\.pdf$/i, "") === oldBase) pdf = `${now.replace(/\.docx?$/i, "")}.pdf`;
        name = now;
        await admin.from("reports").update({ checked_name: name, file_name: name, pdf_name: pdf }).eq("id", r.id);
      }
    }
    out.push({ id: r.id, main_folder: r.main_folder, project_folder: r.project_folder_name, report_folder: r.folder_name, checked_folder: r.checked_file_id === r.drive_file_id ? "." : CHECKED_FOLDER, file_name: name, pdf_name: pdf });
  }
  return out;
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
    // sent: the clerk's own file is overwritten with the checked version, clean (spelling fixed, any changes the
    // checker made, no comments left in), keeping its place in the folder and Drive's history of the old version; it
    // takes the folder's naming pattern; the working copy in "Checked (dashboard)" then goes to the bin (Ronan, 15 Nov
    // 2026: "it also then overwrites the file that the guys uploaded with the new one")
    // checked in place (from 16 Nov 2026): the clerk's file already is the checked version; only the comments come out
    if (rep.checked_file_id && rep.checked_folder_id) {
      try {
        const checked = Buffer.from(await g.download(rep.checked_file_id));
        // comments out, but the tracked spelling corrections stay in so the clerk sees them (Ronan, 16 Nov 2026)
        await g.replaceContent(rep.drive_file_id, await cleanCopy(checked, { keepChanges: true }), DOCX);
        if (rep.checked_name && rep.checked_name !== rep.file_name) await g.rename(rep.drive_file_id, rep.checked_name).catch(() => undefined);
        if (rep.checked_file_id !== rep.drive_file_id) await g.binOriginalReport(rep.checked_file_id);
        await admin.from("reports").update({ original_trashed_at: new Date().toISOString(), file_name: rep.checked_name ?? rep.file_name, checked_file_id: null }).eq("id", reportId);
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

/** The folder checked copies went in before reports were checked in place (16 Nov 2026); old ones may still be there. */
export const CHECKED_FOLDER = "Checked (dashboard)";

/**
 * Page numbers for the points found in a report (Ronan, 16 Nov 2026: listed on the dashboard by page, not as comments
 * in the Word file). A Word file has no fixed pages, so the Word helper on the office PC opens each checked report,
 * finds each point's few words and says which page Word puts them on.
 */
export async function pagesQueue(admin: SupabaseClient) {
  const { data } = await admin.from("reports").select("id,main_folder,project_folder_name,folder_name,file_name,checked_at,issues,checked_file_id,drive_file_id")
    .eq("status", "ready").eq("fixes->>pages_state", "waiting").order("checked_at").limit(8);
  return (data ?? []).filter((r) => r.checked_file_id === r.drive_file_id && r.main_folder).map((r) => ({
    id: r.id, rev: r.checked_at, main_folder: r.main_folder, project_folder: r.project_folder_name, report_folder: r.folder_name, file_name: r.file_name,
    find: ((r.issues ?? []) as Issue[]).map((i, k) => ({ k, near: i.near ?? null })).filter((x) => x.near),
  }));
}

/** The helper's answer: { rev, pages: { [issue index]: page or null }, total }, or an error. */
export async function pagesFound(admin: SupabaseClient, id: string, body: { rev?: string; pages?: Record<string, number | null>; total?: number; error?: string }) {
  const { data: r } = await admin.from("reports").select("checked_at,issues,fixes").eq("id", id).single();
  if (!r || r.checked_at !== body.rev) return false; // checked again since: the new check asks afresh
  const fixes = { ...(r.fixes ?? {}) } as Record<string, unknown>;
  if (body.error) {
    // tried three times, then left: the points still show, with their words to search for
    const tries = Number(fixes.pages_tries ?? 0) + 1;
    await admin.from("reports").update({ fixes: { ...fixes, pages_tries: tries, pages_state: tries >= 3 ? "failed" : "waiting", pages_error: body.error.slice(0, 200) } }).eq("id", id);
    return false;
  }
  const issues = ((r.issues ?? []) as Issue[]).map((i, k) => ({ ...i, page: typeof body.pages?.[k] === "number" ? body.pages[k] : i.page ?? null }));
  await admin.from("reports").update({ issues, fixes: { ...fixes, pages_state: "done", page_count: body.total ?? null } }).eq("id", id);
  return true;
}
