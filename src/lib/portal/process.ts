import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { clerkFolder, sub } from "@/lib/clerk-join";
import { readDocument, aiConfigured, type Kind } from "./read-document";
import { PI_MIN_PENCE, PL_MIN_PENCE } from "./data";

/**
 * What happens after a clerk uploads (Ronan, 15 Nov 2026: accept everything, check afterwards):
 *   1. file it in Personnel/<Name>/<subfolder> in Drive (the copy in temporary storage is then removed)
 *   2. basic safety check of the file itself
 *   3. AI reads it (insurance, qualification or invoice) and the results go into the clerk's record
 *   4. problems become an issue for Ronan and, where the clerk can fix it, a Gmail DRAFT to them (never sent)
 * Every step is safe to repeat: the hourly job picks up anything that stopped half way.
 */
export const SUBFOLDER: Record<string, string> = {
  insurance: "insurance certs",            // same names the old portal used
  qualification: "certificates and qualifications",
  invoice: "invoices",
  company_invoice: "invoices",
};

type Row = {
  id: string; receipt: string; clerk_id: string | null; email: string; kind: Kind; doc_type: string | null; file_name: string | null;
  mime: string | null; bytes: number | null; sha256: string | null; storage_path: string | null; drive_file_id: string | null;
  status: string; scan_state: string | null; ai_state: string | null; issues: string[]; received_at: string;
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\b(ltd|limited|plc|llp)\b/g, "").replace(/[^a-z0-9]/g, "");
const today = () => new Date().toISOString().slice(0, 10);

function sniff(buf: Buffer, mime: string | null) {
  const head = buf.subarray(0, 8).toString("latin1");
  if (head.startsWith("%PDF-")) return "application/pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.startsWith("RIFF") && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return mime ?? "application/octet-stream";
}

/** Basic checks on the file itself (no antivirus engine here; Google Drive also scans files it stores). */
function safety(buf: Buffer, type: string) {
  const notes: string[] = [];
  if (!buf.length) notes.push("The file is empty");
  if (type === "application/pdf") {
    const text = buf.toString("latin1");
    if (/\/(JavaScript|JS)\b/.test(text)) notes.push("The PDF contains JavaScript");
    if (/\/Launch\b/.test(text)) notes.push("The PDF tries to launch a program");
    if (/\/EmbeddedFile\b/.test(text)) notes.push("The PDF has files embedded in it");
    if (/\/Encrypt\b/.test(text)) notes.push("The PDF is password-protected or encrypted");
  }
  return notes;
}

async function driveUpload(admin: SupabaseClient, folderId: string, name: string, type: string, body: Buffer) {
  const g = await driveClient(admin);
  const boundary = `b${randomBytes(8).toString("hex")}`;
  const meta = JSON.stringify({ name, parents: [folderId] });
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`),
    body, Buffer.from(`\r\n--${boundary}--`),
  ]);
  return (await g.upload(payload, `multipart/related; boundary=${boundary}`)).id;
}

async function draftCorrection(admin: SupabaseClient, u: Row, problems: string[]) {
  const { data: c } = await admin.from("clerks").select("name,email").eq("id", u.clerk_id!).single();
  if (!c?.email) return;
  const what = u.kind === "insurance" ? "insurance certificate" : u.kind === "invoice" ? "invoice" : "certificate";
  const body = `Hi ${c.name.split(" ")[0]},\n\nThanks for uploading your ${what} (${u.file_name ?? "your file"}). We checked it and found:\n\n${problems.map((p) => `- ${p}`).join("\n")}\n\nCould you upload a corrected or renewed copy on the portal when you can?\n\nhttps://portal.beamore.co.uk\n\nMany thanks,\nRonan\n\nRonan O'Boyle\nBeamore Management Ltd`;
  // waits on the "Emails to send" page (Ronan, 16 Nov 2026), not in Gmail Drafts
  const { queueEmail } = await import("@/lib/outbox");
  await queueEmail(admin, { kind: "portal-correction", to: c.email, subject: `Please update your ${what}`, body, clerkId: u.clerk_id, ref: u.id });
  await admin.from("portal_uploads").update({ correction_drafted_at: new Date().toISOString() }).eq("id", u.id);
}

/** Names an insurance certificate may be in: the clerk's own name and the companies they invoice through. */
async function knownNames(admin: SupabaseClient, clerkId: string) {
  const [{ data: c }, { data: cos }, { data: comp }] = await Promise.all([
    admin.from("clerks").select("name").eq("id", clerkId).single(),
    admin.from("clerk_companies").select("company_name,status").eq("clerk_id", clerkId),
    admin.from("clerk_compliance").select("company_name").eq("clerk_id", clerkId).maybeSingle(),
  ]);
  return [c?.name, comp?.company_name, ...(cos ?? []).filter((x) => x.status !== "Revoked").map((x) => x.company_name)].filter(Boolean).map((n) => norm(n as string));
}

async function applyInsurance(admin: SupabaseClient, u: Row, r: Record<string, unknown>) {
  const problems: string[] = [], forBeamore: string[] = [];
  if (!r.readable || !r.is_insurance_document) {
    problems.push(r.is_insurance_document === false ? "This doesn't look like an insurance certificate or schedule" : "The certificate couldn't be read clearly or is missing details. Please upload a complete, readable copy");
    return { problems, forBeamore };
  }
  const insured = String(r.insured_name ?? "");
  const names = u.clerk_id ? await knownNames(admin, u.clerk_id) : [];
  const nameOk = !!insured && names.some((n) => n && (norm(insured).includes(n) || n.includes(norm(insured))));
  if (!insured) problems.push("The certificate doesn't show who is insured");
  else if (!nameOk) forBeamore.push(`Insured name "${insured}" doesn't match the clerk's name or a company we have for them`);
  const pols = (r.policies as { type: string; description: string; cover_gbp: number | null; starts: string | null; expires: string | null }[]) ?? [];
  if (!pols.length) problems.push("No cover sections could be read from the certificate");
  await admin.from("insurance_policies").delete().eq("upload_id", u.id);
  for (const p of pols) {
    const cover = p.cover_gbp === null ? null : Math.round(p.cover_gbp * 100);
    const label = p.type === "PI" ? "Professional indemnity" : p.type === "PL" ? "Public liability" : p.type === "EL" ? "Employers liability" : p.description || "Other cover";
    if (p.expires && p.expires < today()) problems.push(`${label}: this certificate expired on ${p.expires}. Please upload the renewed one`);
    if (p.type === "PI" && cover !== null && cover < PI_MIN_PENCE) problems.push(`${label}: cover is £${(cover / 100).toLocaleString("en-GB")}; Beamore asks for £1 million`);
    if (p.type === "PL" && cover !== null && cover < PL_MIN_PENCE) problems.push(`${label}: cover is £${(cover / 100).toLocaleString("en-GB")}; public liability must be at least £1 million`);
    if (!p.expires) forBeamore.push(`${label}: no expiry date could be read`);
    await admin.from("insurance_policies").insert({
      upload_id: u.id, clerk_id: u.clerk_id, type: p.type, description: p.description, insurer: r.insurer ?? null, insured_name: insured || null,
      policy_number: r.policy_number ?? null, cover_pence: cover, starts: p.starts, expires: p.expires, evidence: { read_by: "AI" },
      checked_at: new Date().toISOString(), checked_by: "AI", source: "portal",
    });
    const col = p.type === "PI" ? "pi_insurance_expiry" : p.type === "PL" ? "pl_insurance_expiry" : null;
    if (col && p.expires && u.clerk_id && nameOk) {
      await admin.from("clerk_compliance").upsert({ clerk_id: u.clerk_id }, { onConflict: "clerk_id", ignoreDuplicates: true });
      const { data: cur } = await admin.from("clerk_compliance").select(col).eq("clerk_id", u.clerk_id).single();
      const was = (cur as Record<string, string | null> | null)?.[col];
      if (!was || was < p.expires) await admin.from("clerk_compliance").update({ [col]: p.expires, updated_at: new Date().toISOString() }).eq("clerk_id", u.clerk_id);
    }
  }
  if (!pols.some((p) => p.type === "PI")) forBeamore.push("No professional indemnity section on this certificate (fine if it's a separate PL/EL certificate)");
  return { problems, forBeamore };
}

async function applyQualification(admin: SupabaseClient, u: Row, r: Record<string, unknown>) {
  const problems: string[] = [], forBeamore: string[] = [];
  if (!r.readable) { problems.push("The certificate couldn't be read clearly. Please upload a complete, readable copy"); return { problems, forBeamore }; }
  const type = String(r.doc_type ?? "");
  if (!u.doc_type || u.doc_type === "Other") await admin.from("portal_uploads").update({ doc_type: type.slice(0, 60) }).eq("id", u.id);
  if (!u.clerk_id) return { problems, forBeamore };
  await admin.from("clerk_compliance").upsert({ clerk_id: u.clerk_id }, { onConflict: "clerk_id", ignoreDuplicates: true });
  const t = `${type} ${u.doc_type ?? ""}`;
  if (/cscs/i.test(t)) {
    if (r.expires && (r.expires as string) < today()) problems.push(`Your CSCS card expired on ${r.expires}. Please upload your new card when you have it`);
    await admin.from("clerk_compliance").update({ cscs_number: r.number ?? null, cscs_expiry: r.expires ?? null, updated_at: new Date().toISOString() }).eq("clerk_id", u.clerk_id);
  } else if (/ciob|icwci|cabe|rics/i.test(t)) {
    const body = /ciob/i.test(t) ? "CIOB" : /icwci/i.test(t) ? "ICWCI" : /cabe/i.test(t) ? "CABE" : "RICS";
    await admin.from("clerk_compliance").update({ chartership_body: body, chartership_grade: r.grade ?? null, chartership_number: r.number ?? null, chartership_renewal: r.expires ?? null, updated_at: new Date().toISOString() }).eq("clerk_id", u.clerk_id);
  }
  return { problems, forBeamore };
}

async function applyInvoice(admin: SupabaseClient, u: Row, r: Record<string, unknown>) {
  const problems: string[] = [], forBeamore: string[] = [];
  if (!r.readable || !r.is_invoice) { forBeamore.push(r.is_invoice === false ? "This doesn't look like an invoice" : "The invoice couldn't be read clearly"); return { problems, forBeamore }; }
  const period = (r.period as string | null) ?? ((r.invoice_date as string | null)?.slice(0, 7) ?? null);
  let diaryDays: number | null = null;
  if (u.clerk_id && period) {
    const [y, m] = period.split("-").map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const { data: v } = await admin.from("diary_visits").select("days").eq("clerk_id", u.clerk_id).eq("side", "charged").gte("visit_date", `${period}-01`).lte("visit_date", end);
    diaryDays = (v ?? []).reduce((s, x) => s + Number(x.days), 0);
    if (r.days !== null && r.days !== undefined && Math.abs(Number(r.days) - diaryDays) > 0.01) forBeamore.push(`Invoice charges ${r.days} days; the diary shows ${diaryDays} for ${period}`);
  }
  if (r.supplier && u.clerk_id) {
    const names = await knownNames(admin, u.clerk_id);
    const sup = norm(String(r.supplier));
    if (!names.some((n) => n && (sup.includes(n) || n.includes(sup)))) forBeamore.push(`Invoice is from "${r.supplier}", which isn't linked to this person yet (link it under Company links)`);
  }
  const pence = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
  if (r.invoice_number && u.clerk_id) {
    const { data: dup } = await admin.from("portal_invoice_checks").select("upload_id,portal_uploads!inner(clerk_id,status)").ilike("invoice_number", String(r.invoice_number))
      .eq("portal_uploads.clerk_id", u.clerk_id).neq("portal_uploads.status", "deleted").neq("upload_id", u.id).limit(1);
    if (dup?.length) forBeamore.push(`Invoice number ${r.invoice_number} has already been uploaded`);
  }
  await admin.from("portal_invoice_checks").upsert({
    upload_id: u.id, supplier: r.supplier ?? null, invoice_number: r.invoice_number ?? null, invoice_date: r.invoice_date ?? null, period,
    net_pence: pence(r.net_gbp), vat_pence: pence(r.vat_gbp), gross_pence: pence(r.gross_gbp), cis: !!r.cis, diary_days: diaryDays,
    checked_at: new Date().toISOString(), checked_by: "AI",
  });
  // queue it for the salmon side of the diary (written by the 15-minute job, one invoice at a time)
  const visits = (r.visits as unknown[] | undefined) ?? [];
  await admin.from("portal_uploads").update({
    period,
    diary_state: visits.length ? "waiting" : "needs_review",
    diary_note: visits.length ? "Waiting to go into the diary" : "The invoice doesn't list the dates worked, so it can't go in the diary automatically",
  }).eq("id", u.id);
  return { problems, forBeamore };
}

export async function processUpload(admin: SupabaseClient, id: string) {
  const { data } = await admin.from("portal_uploads").select("*").eq("id", id).single();
  const u = data as Row | null;
  if (!u || ["deleted", "uploading"].includes(u.status)) return;
  let file: Buffer | null = null;
  let type = u.mime ?? "application/octet-stream";

  // 1 + 2: file it in the clerk's Personnel folder, with a basic safety check
  if (!u.drive_file_id) {
    if (!u.storage_path) return;
    const { data: blob, error } = await admin.storage.from("portal-uploads").download(u.storage_path);
    if (error || !blob) throw new Error(`download ${u.receipt}: ${error?.message}`);
    file = Buffer.from(await blob.arrayBuffer());
    type = sniff(file, u.mime);
    const sha = createHash("sha256").update(file).digest("hex");
    const notes = safety(file, type);
    let folderId: string;
    if (u.clerk_id) {
      const { data: c } = await admin.from("clerks").select("name").eq("id", u.clerk_id).single();
      const person = await clerkFolder(admin, u.clerk_id, c!.name);
      const g = await driveClient(admin);
      folderId = (await sub(g, person, SUBFOLDER[u.kind], true))!;
    } else throw new Error(`upload ${u.receipt} has no clerk`);
    const stamp = u.received_at.slice(0, 10);
    const name = `${stamp} ${u.kind === "qualification" && u.doc_type ? `${u.doc_type} - ` : ""}${u.file_name ?? u.receipt}`;
    const fileId = await driveUpload(admin, folderId, name, type, file);
    const issues = notes.length ? [...u.issues, ...notes.map((n) => `Safety check: ${n}`)] : u.issues;
    await admin.from("portal_uploads").update({
      drive_file_id: fileId, drive_folder_id: folderId, sha256: sha, mime: type, status: "filed",
      scan_state: notes.length ? "suspicious" : "clean", scan_note: notes.join("; ") || null, issues,
    }).eq("id", u.id);
    await admin.storage.from("portal-uploads").remove([u.storage_path]);
    await admin.from("portal_uploads").update({ storage_path: null }).eq("id", u.id);
    Object.assign(u, { drive_file_id: fileId, status: "filed", sha256: sha, mime: type, issues, scan_state: notes.length ? "suspicious" : "clean" });
    // same file uploaded before: keep both, note it
    const { data: same } = await admin.from("portal_uploads").select("receipt").eq("sha256", sha).eq("clerk_id", u.clerk_id).neq("id", u.id).neq("status", "deleted").limit(1);
    if (same?.length) await admin.from("portal_uploads").update({ issues: [...issues, "Same file as an earlier upload"] }).eq("id", u.id);
  }

  // 3: AI reads it
  if (u.ai_state === "done" || u.scan_state === "suspicious") return;
  const readable = /^(application\/pdf|image\/(jpeg|png|gif|webp))$/.test(u.mime ?? type);
  if (!readable) { await admin.from("portal_uploads").update({ ai_state: "skipped", status: "needs_beamore", issues: [...u.issues, "Not a PDF or photo, so it couldn't be read automatically. Please look at it in Drive"] }).eq("id", u.id); return; }
  if (!aiConfigured()) { await admin.from("portal_uploads").update({ ai_state: "pending" }).eq("id", u.id); return; }
  if (!file) {
    const g = await driveClient(admin);
    file = Buffer.from(await g.download(u.drive_file_id!));
  }
  let result: Record<string, unknown>;
  try {
    result = await readDocument(u.kind, file, u.mime ?? type);
  } catch (e) {
    await admin.from("portal_uploads").update({ ai_state: "failed", scan_note: `AI: ${e instanceof Error ? e.message.slice(0, 200) : "failed"}` }).eq("id", u.id);
    return;
  }
  const apply = u.kind === "insurance" ? applyInsurance : u.kind === "qualification" ? applyQualification : applyInvoice;
  const { problems, forBeamore } = await apply(admin, u, result);
  const ai = (result.problems as string[] | undefined) ?? [];
  const issues = [...u.issues.filter((i) => i.startsWith("Safety check") || i.startsWith("Same file")), ...problems, ...forBeamore];
  const status = problems.length ? "needs_correction" : forBeamore.length ? "needs_beamore" : u.kind === "invoice" ? "checked" : "accepted";
  await admin.from("portal_uploads").update({ ai_state: "done", ai_result: { ...result, ai_notes: ai }, issues, status }).eq("id", u.id);
  // (old-portal uploads: the old portal already emailed the clerk, so no new draft)
  if (problems.length && u.clerk_id && (u as Row & { source?: string }).source !== "legacy") await draftCorrection(admin, { ...u, issues }, problems).catch(() => undefined);
}

/** Hourly: anything not yet filed or read (e.g. the AI key was added later, or a step failed). */
export async function processPending(admin: SupabaseClient) {
  const { data } = await admin.from("portal_uploads").select("id")
    .neq("status", "deleted").neq("status", "uploading") // old-portal uploads too, when queued for reading again
    .or("drive_file_id.is.null,ai_state.is.null,ai_state.eq.pending")
    .order("received_at").limit(15);
  let done = 0, failed = 0;
  for (const r of data ?? []) {
    try { await processUpload(admin, r.id); done++; } catch { failed++; }
  }
  // uploads that never finished arriving (browser closed) are cleared after a day
  await admin.from("portal_uploads").update({ status: "deleted", deleted_reason: "Upload never finished", deleted_at: new Date().toISOString(), deleted_by: "system" })
    .eq("status", "uploading").lt("received_at", new Date(Date.now() - 864e5).toISOString());
  return { done, failed };
}
