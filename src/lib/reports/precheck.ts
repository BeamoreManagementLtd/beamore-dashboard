import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { driveClient } from "@/lib/google";
import { readReport, photoStats, photoHashes, reusedCount, withoutTemplate, uncaptioned, unticked, uniformPhotos, trackerItems } from "./docx.mjs";
import { checkReport } from "./check";
import { judgeReport, isSpellingSlip } from "./pipeline";
import { scoreTotal } from "./score";
import { isMonthly, lastDiaryOfMonth, compareTrackers, trackerGapText } from "./monthly";
import { conventionName } from "./naming.mjs";
import { templateBits, compareTemplate, pickLast, type TemplateCheck } from "./template";
import { feedbackEmail, type FeedbackReport } from "./feedback-email";

export const PRECHECK_BUCKET = "report-prechecks";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * A clerk's own check of a draft report, before it goes in Google Drive (Ronan, 18 Nov 2026: "let them have the
 * feedback first when they upload it, fix the feedback, and then they can put it on Google Drive"). The same check and
 * the same marking as the office's (judgeReport), but nothing is changed or saved anywhere: no Drive, no rename, no
 * emails. The clerk gets the points and the spelling slips to put right themselves. The draft is removed from storage
 * once it has been read; only the feedback is kept.
 */
export async function precheckOne(admin: SupabaseClient, id: string) {
  const { data: pc } = await admin.from("report_prechecks").update({ status: "checking", started_at: new Date().toISOString(), error: null }).eq("id", id).select("*").single();
  if (!pc?.storage_path) throw new Error("No such check");
  const { data: blob, error } = await admin.storage.from(PRECHECK_BUCKET).download(pc.storage_path);
  if (error || !blob) throw new Error("The file couldn't be read. Please try uploading it again.");
  const raw = Buffer.from(await blob.arrayBuffer());
  let r;
  try { r = await readReport(raw); } catch { throw new Error("This doesn't look like a Word (.docx) file. Please save it from Word as .docx and try again."); }
  let stats = await photoStats(r, sharp);

  // the job, as the office's check sees it
  const { data: p } = pc.project_id ? await admin.from("projects").select("id,name,display_name,dfe_project_number,po_number,clerk_id,clerk_me_id,details,clients(name)").eq("id", pc.project_id).single() : { data: null };
  const ourClient = (p?.clients as unknown as { name?: string } | null)?.name ?? null;
  const endClient = ((p?.details ?? {}) as { end_client?: string }).end_client ?? null;
  const clerkIds = [p?.clerk_id, p?.clerk_me_id].filter(Boolean) as string[];
  const { data: clerks } = clerkIds.length ? await admin.from("clerks").select("id,name").in("id", clerkIds) : { data: [] };
  const { data: found } = pc.project_id ? await admin.from("reports").select("id,file_name,renamed_from,folder_id,folder_name,report_number,visit_date,text_snapshot,photo_hashes,photo_count,drive_file_id,original_revision_id,uploaded_at")
    .eq("project_id", pc.project_id).eq("kind", pc.kind).not("checked_at", "is", null).order("uploaded_at", { ascending: false }).limit(9) : { data: [] };
  // the same report already in Drive (checked again here, say) isn't its own previous report: its photos would all
  // look reused
  const same = (n: string | null) => !!n && n.replace(/\.docx?$/i, "").trim().toLowerCase() === pc.file_name.replace(/\.docx?$/i, "").trim().toLowerCase();
  const earlier = (found ?? []).filter((e) => !same(e.file_name) && !same(e.renamed_from)).slice(0, 8);
  const prev = earlier?.[0] ?? null;
  const counts = (earlier ?? []).slice(0, 5).map((e) => e.photo_count).filter((n): n is number => typeof n === "number");
  const usual = counts.length >= 2 ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : null;
  await photoHashes(r, sharp, stats); // fingerprints each photo (p.hash), for the template check
  // the job's template pictures (DfE logos and the like) aren't photos: not counted, not "reused", not "too small"
  const tpl = withoutTemplate(stats, (earlier ?? []).map((e) => e.photo_hashes as string[] | null));
  stats = tpl.stats;
  const reused = reusedCount(tpl.hashes, prev?.photo_hashes ?? null);
  const used = stats.list.filter((x) => x.used);
  const picked = used.length <= 12 ? used : Array.from({ length: 12 }, (_, k) => used[Math.floor((k * used.length) / 12)]);
  const thumbs: Buffer[] = [];
  for (const ph of picked) {
    try { thumbs.push(await sharp(await r.zip.file(ph.path)!.async("nodebuffer"), { failOn: "none" }).rotate().resize({ width: 320, height: 320, fit: "inside" }).jpeg({ quality: 55 }).toBuffer()); } catch { /* skip */ }
  }
  // the folder the job's reports go in (from the last one), for the file name pattern and a tracker kept beside them
  const folderId = prev?.folder_id ?? null, folderName = prev?.folder_name ?? "";
  const g = folderId || prev ? await driveClient(admin).catch(() => null) : null;

  // started from last week's checked report, with the office's changes kept?
  let template: TemplateCheck | null = null;
  if (g && earlier?.length) {
    try {
      const [last, before] = pickLast({ ...earlier[0], file_name: pc.file_name, folder_name: folderName, report_number: null }, earlier);
      if (last) {
        const lastBits = await templateBits(await g.download(last.drive_file_id));
        const asSent = last.original_revision_id ? await templateBits(await g.downloadRevision(last.drive_file_id, last.original_revision_id)).catch(() => null) : null;
        const beforeBits = before ? await templateBits(await g.download(before.drive_file_id)).catch(() => null) : null;
        template = compareTemplate(await templateBits(raw), lastBits, asSent, beforeBits, { id: last.id, number: last.report_number, name: last.file_name });
      }
    } catch { template = null; }
  }

  // the clerk's earlier checks of this same report (same file name, the last 3 days), so it's marked against the same
  // list each time
  const { data: before3 } = await admin.from("report_prechecks").select("issues,fixes")
    .eq("clerk_id", pc.clerk_id).eq("file_name", pc.file_name).eq("status", "done").neq("id", pc.id)
    .gte("created_at", new Date(Date.now() - 3 * 864e5).toISOString()).order("created_at", { ascending: false }).limit(3);
  const earlierChecks = (before3 ?? []).map((b) => {
    const parts = (((b.fixes ?? {}) as { score_parts?: { label: string; got: number; of: number; improve?: string }[] }).score_parts ?? []);
    const q = parts.find((x) => x.label === "Quality of the information");
    return { quality: q ? Math.round((q.got / q.of) * 100) : null, why: q?.improve ?? null, points: ((b.issues ?? []) as { text: string }[]).map((i) => i.text).slice(0, 12) };
  });
  const ai = await checkReport({
    earlierChecks,
    fileName: pc.file_name, folder: folderName, project: p?.name ?? "",
    client: ourClient && endClient ? `${ourClient} (Beamore's client), working for the end client ${endClient}: the report may name either as the client, and both are correct, so don't raise it` : ourClient,
    projectNumbers: [p?.dfe_project_number, p?.po_number].filter((x): x is string => !!x && /\d/.test(x)),
    noProjectNumber: !!((p?.details ?? {}) as { no_project_number?: boolean }).no_project_number,
    expectedClerks: (clerks ?? []).map((c) => c.name), diaryVisits: [],
    previous: prev ? { number: prev.report_number, date: prev.visit_date, text: prev.text_snapshot ?? "" } : null,
    paragraphs: r.paragraphs, blanks: r.blanks, placeholders: r.placeholders,
    photos: { count: stats.count, blurry: stats.blurry, smallOnPage: stats.smallOnPage, stretched: stats.stretched, mb: raw.length / 1e6, usual, reused, uncaptioned: uncaptioned(r) },
    unticked: unticked(r), thumbnails: thumbs, today: new Date().toISOString().slice(0, 10), appendix: null,
  });

  // the name it would have in the folder (only suggested)
  let nameFixed: string | null = null;
  if (g && folderId) {
    try {
      const sibs = await g.json<{ files: { name: string }[] }>("files", { q: `'${folderId}' in parents and trashed = false and (mimeType = '${DOCX}' or mimeType = 'application/pdf')`, fields: "files(name)", orderBy: "modifiedTime desc", pageSize: "40", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      const visitDate = ai.visit_date && /^\d{4}-\d{2}-\d{2}$/.test(ai.visit_date) ? ai.visit_date : null;
      const want = conventionName(pc.file_name, sibs.files.map((f) => f.name).filter((n) => n !== pc.file_name), visitDate, ai.report_number);
      // the file already in the folder with that name is this report's earlier draft, not a clash
      if (want && want.toLowerCase() !== pc.file_name.toLowerCase()) nameFixed = want;
    } catch { nameFixed = null; }
  }
  const sideways = new Set((ai.rotate ?? []).map((t) => t.photo)).size;
  const uniform = uniformPhotos(r, stats, await r.zip.file("word/_rels/document.xml.rels")!.async("string"));
  const heldBack = (ai.spelling ?? []).filter((s) => !isSpellingSlip(s.find, s.replace));
  ai.spelling = (ai.spelling ?? []).filter((s) => isSpellingSlip(s.find, s.replace));
  const monthly = isMonthly({ file_name: pc.file_name, folder_name: folderName });

  const j = await judgeReport({
    r, ai, kind: pc.kind, monthly, appendix: false, usual, reused, ourClient, endClient, stats, rawBytes: raw.length,
    sideways, wasUniform: uniform.wasUniform, rotated: 0, nameFixed, template, skipped: [], heldBack,
    findTrackerFile: async () => {
      if (!g || !folderId) return null;
      const since = new Date(Date.now() - 21 * 864e5).toISOString();
      const tf = await g.json<{ files: { name: string }[] }>("files", { q: `'${folderId}' in parents and trashed = false and modifiedTime > '${since}' and (name contains 'tracker' or name contains 'defect' or name contains 'defects' or name contains 'issues') and (mimeType = 'application/pdf' or mimeType contains 'spreadsheet' or mimeType contains 'excel')`, fields: "files(name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      return tf.files[0]?.name ?? null;
    },
    monthlyGap: async () => {
      if (!g) return null;
      const last = await lastDiaryOfMonth(admin, { id: "00000000-0000-0000-0000-000000000000", project_id: pc.project_id, kind: pc.kind, file_name: pc.file_name, uploaded_at: new Date().toISOString() });
      if (!last) return null;
      const gap = compareTrackers(trackerItems(r), trackerItems(await readReport(Buffer.from(await g.download(last.drive_file_id)))), r.paragraphs.map((x) => x.text));
      return { against: last.file_name, month: last.month, missing: gap.missing, behind: gap.behind, text: trackerGapText(gap, last.file_name), details: gap.details };
    },
  });

  const beamore = await isBeamoreReport(r, p);
  await admin.from("report_prechecks").update({
    status: "done", checked_at: new Date().toISOString(), score: scoreTotal(j.parts), summary: ai.summary,
    issues: j.issues, clerk_points: j.clerkPoints,
    fixes: {
      spelling: ai.spelling.map((s) => ({ find: s.find, replace: s.replace })), wording: heldBack.map((s) => ({ find: s.find, replace: s.replace })),
      score_parts: j.parts, words: j.words, photos: stats.count, mixed: !uniform.wasUniform, stretched: stats.stretched, sideways, renamed: nameFixed,
      report_number: ai.report_number, visit_date: ai.visit_date, mb: +(raw.length / 1e6).toFixed(1), beamore, summary: ai.summary,
    },
    storage_path: null,
  }).eq("id", id);
  // the draft isn't kept: it was only for this check
  await admin.storage.from(PRECHECK_BUCKET).remove([pc.storage_path]).catch(() => undefined);
  await emailPrecheck(admin, id).catch(() => undefined);
}

/**
 * The results emailed to the clerk who asked for the check (Ronan, 18 Nov 2026), from ai@beamore.co.uk like all the AI
 * feedback emails: what the check found, that nothing has been changed, and that the final report still needs
 * uploading to Google Drive once they've put things right. Once per check; kept on "Emails to send" as a record.
 */
export async function emailPrecheck(admin: SupabaseClient, id: string) {
  const { data: pc } = await admin.from("report_prechecks").select("id,clerk_id,file_name,score,clerk_points,fixes,status,projects(name,display_name)").eq("id", id).single();
  if (!pc || pc.status !== "done") return false;
  const { data: c } = await admin.from("clerks").select("id,name,email,active").eq("id", pc.clerk_id).single();
  if (!c?.email) return false;
  const { data: before } = await admin.from("email_outbox").select("id").eq("kind", "ai-precheck").eq("ref", id).limit(1);
  if (before?.length) return false;
  const p = pc.projects as unknown as { name?: string; display_name?: string } | null;
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://dashboard.beamore.co.uk";
  const e = feedbackEmail(pc as unknown as FeedbackReport, { first: c.name.split(" ")[0], job: p?.name ?? p?.display_name ?? "your job", site, precheck: true });
  const { sendFromMailbox, AI_MAILBOX } = await import("@/lib/google-user");
  const res = (await sendFromMailbox(admin, AI_MAILBOX, "Beamore AI", { to: c.email, subject: e.subject, body: e.text, html: e.html }))
    ?? (await (await driveClient(admin)).sendAutomaticAs({ email: AI_MAILBOX, name: "Beamore AI" }, { to: c.email, subject: e.subject, body: e.text }));
  if (!res) return false; // ai@ isn't connected: never sent from anyone else's address
  const { queueEmail } = await import("@/lib/outbox");
  await queueEmail(admin, { kind: "ai-precheck", to: c.email, subject: e.subject, body: e.text, clerkId: c.id, ref: id, status: "sent", note: "Sent automatically from ai@beamore.co.uk" });
  return true;
}

// words in job names that don't identify a job on their own
const GENERIC = new Set(["school", "schools", "academy", "college", "primary", "secondary", "high", "junior", "infant", "infants", "church", "england", "catholic", "the", "and", "for", "new", "block", "phase", "building", "works", "project", "site", "house", "centre", "center", "court", "road", "street", "lane", "park", "village", "fabric", "build", "trust", "girls", "boys", "grammar", "community", "free", "sixth", "form", "campus", "extension", "refurbishment"]);

/**
 * Is this a Beamore report? (Ronan, 18 Nov 2026: "highlight to me if anyone tries to check a report that's not a
 * Beamore report".) Beamore's reports name Beamore (or BML in the DfE file codes) in the text, a header or footer, or
 * the file's details. Some DfE forms don't (4 of 45 tried), but they always name the job, so only a report that names
 * neither Beamore nor the job chosen is flagged.
 */
export async function isBeamoreReport(r: Awaited<ReturnType<typeof readReport>>, p: { name?: string | null; display_name?: string | null; dfe_project_number?: string | null; po_number?: string | null } | null) {
  let text = "";
  for (const n of Object.keys(r.zip.files)) if (/^(word\/(document|header\d*|footer\d*)\.xml|docProps\/(core|app|custom)\.xml)$/.test(n)) text += " " + (await r.zip.file(n)!.async("string")).replace(/<[^>]+>/g, " ");
  text = text.replace(/\s+/g, " ");
  if (/beamore|BML/i.test(text)) return { ok: true, why: "Names Beamore" };
  const lower = text.toLowerCase();
  const nums = [p?.dfe_project_number, p?.po_number].filter((x): x is string => !!x && /\d{3}/.test(x)).filter((x) => lower.includes(x.toLowerCase()));
  const words = [...new Set(`${p?.name ?? ""} ${p?.display_name ?? ""}`.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w)))];
  const hits = words.filter((w) => new RegExp(`\\b${w.replace(/'/g, "'?")}`, "i").test(text));
  // one shared ordinary word isn't enough ("leisure" in a school report): the job number, the first word of the job's
  // name (usually the place: "Ormiston" for Ormiston Bridge Academy), or two of its words
  if (nums.length || hits.includes(words[0]) || hits.length >= 2) return { ok: true, why: `Doesn't name Beamore, but is about the job (${[...nums, ...hits].slice(0, 3).join(", ")})` };
  return { ok: false, why: `Doesn't mention Beamore or the job chosen (${p?.display_name ?? p?.name ?? "no job"})` };
}

/** Any check left waiting (the page was closed while it ran, say), picked up by the 15-minute report job. */
export async function precheckWaiting(admin: SupabaseClient, budgetMs = 120_000) {
  const t0 = Date.now();
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data } = await admin.from("report_prechecks").select("id,status,started_at,created_at")
    .or(`status.eq.waiting,and(status.eq.checking,started_at.lt.${stale})`).order("created_at").limit(5);
  let done = 0;
  for (const w of data ?? []) {
    if (Date.now() - t0 > budgetMs) break;
    // a check that keeps failing stops after an hour
    if (Date.parse(w.created_at) < Date.now() - 3600_000) { await admin.from("report_prechecks").update({ status: "failed", error: "The check didn't finish. Please try again." }).eq("id", w.id); continue; }
    try { await precheckOne(admin, w.id); done++; } catch (e) { await failPrecheck(admin, w.id, e); }
  }
  return done;
}

export async function failPrecheck(admin: SupabaseClient, id: string, e: unknown) {
  await admin.from("report_prechecks").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }).eq("id", id);
}
