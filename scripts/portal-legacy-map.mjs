// Maps the old Google portal register (one object per sheet row, keyed by header) into the dashboard's portal tables.
// Nothing is dropped: rows that don't map are reported, and every row is also kept verbatim in portal_legacy_rows.
const bool = (v) => v === true || String(v).toUpperCase() === "TRUE";
const lc = (v) => String(v ?? "").trim().toLowerCase();
const day = (v) => (v ? String(v).slice(0, 10) : null);
const ts = (v) => (v ? new Date(v).toISOString() : null);
const int = (v) => (v === null || v === undefined || v === "" ? null : Math.round(Number(v)));
const json = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const TYPE = { PI: "PI", PL: "PL", "Employers liability": "EL", Other: "other" };

export async function mapLegacy(db, S, { write }) {
  const say = (...a) => console.log(...a);
  const { data: clerks } = await db.from("clerks").select("id,name,email");
  const byEmail = new Map(clerks.filter((c) => c.email).map((c) => [lc(c.email), c]));
  const byName = new Map(clerks.map((c) => [lc(c.name), c]));
  const clerkOf = (email, name) => byEmail.get(lc(email)) ?? (name ? byName.get(lc(name)) : undefined);
  const unmatched = new Set();
  const rowsBy = (sheet, key) => { const m = new Map(); for (const r of S[sheet] ?? []) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };

  // ---- people: portal access per clerk
  const clerkUpdates = [];
  for (const u of S.Users ?? []) {
    if (!["clerk", "archived-clerk"].includes(u.role)) { say(`  staff in old portal (not a clerk): ${u.email} (${u.role})`); continue; }
    const c = clerkOf(u.email, u.name);
    if (!c) { unmatched.add(`Users: ${u.email} ${u.name}`); continue; }
    byEmail.set(lc(u.email), c); // matched by name: their portal email now finds them too
    clerkUpdates.push({ id: c.id, email: c.email ?? lc(u.email), portal_access: bool(u.active) && u.role === "clerk", invoice_upload: bool(u.invoiceApproval), billing: u.billing || null, invoices_paused: bool(u.paused), portal_role: "clerk" });
  }

  // ---- uploads
  const periods = new Map((S.InvoicePeriods ?? []).map((r) => [r.receipt, r.period]));
  const checks = new Map((S.InvoiceChecks ?? []).map((r) => [r.receipt, r]));
  const legacyBy = (receipt) => Object.fromEntries(Object.entries(S).map(([sheet, rows]) => [sheet, rows.filter((r) => r.receipt === receipt || r.key?.includes?.(receipt))]).filter(([, v]) => v.length));
  const uploads = [];
  const stateOf = (st) => (st === "DELETED" || st === "DELETING" ? "deleted" : "received");
  const suppliers = new Map((S.Suppliers ?? []).map((r) => [r.id, r.name]));

  for (const r of S.Submissions ?? []) {
    const company = String(r.owner ?? "").startsWith("supplier:");
    const c = company ? null : clerkOf(r.owner);
    if (!company && r.owner && !c) unmatched.add(`Submissions: ${r.receipt} ${r.owner}`);
    const chk = checks.get(r.receipt);
    const audit = r.state === "DELETED" ? json(r.pipeline) : null;
    uploads.push({
      receipt: r.receipt, clerk_id: c?.id ?? null, email: company ? `supplier:${suppliers.get(r.owner.slice(9)) ?? r.owner.slice(9)}` : lc(r.owner) || "(deleted)",
      kind: company ? "company_invoice" : "invoice", mime: "application/pdf", bytes: int(r.bytes), sha256: r.sha256 || null,
      drive_file_id: r.fileId || null, received_at: ts(r.received), period: chk?.period ?? periods.get(r.receipt) ?? null,
      status: stateOf(r.state) === "deleted" ? "deleted" : chk ? "accepted" : "received",
      scan_state: null, ai_state: "skipped", deleted_at: ts(audit?.at), deleted_by: audit?.actor ?? null, deleted_reason: audit?.reason ?? null,
      file_name: null, source: "legacy", legacy: legacyBy(r.receipt),
    });
  }

  const insFiles = new Map((S.InsuranceFiles ?? []).filter((r) => r.state === "Filed").map((r) => [r.receipt, r]));
  const insChecks = new Map((S.InsuranceChecks ?? []).map((r) => [r.receipt, r]));
  const insExtract = new Map((S.InsuranceExtraction ?? []).map((r) => [r.receipt, r]));
  for (const r of S.InsuranceCertificates ?? []) {
    const c = clerkOf(r.owner);
    if (r.owner && !c) unmatched.add(`InsuranceCertificates: ${r.receipt} ${r.owner}`);
    const chk = insChecks.get(r.receipt), filed = insFiles.get(r.receipt), ex = insExtract.get(r.receipt);
    const issues = (json(chk?.issues) ?? []).map((i) => (i.type ? `${i.type}: ${i.reason}` : i.reason));
    const audit = r.state === "DELETED" ? json(r.requestKey) : null;
    const status = stateOf(r.state) === "deleted" ? "deleted"
      : chk?.state === "Complete" || chk?.state === "Resolved" ? "accepted"
      : chk?.state === "Needs correction" ? "needs_correction"
      : chk?.state === "Needs Beamore attention" ? "needs_beamore" : "received";
    uploads.push({
      receipt: r.receipt, clerk_id: c?.id ?? null, email: lc(r.owner) || "(deleted)", kind: "insurance", mime: "application/pdf",
      bytes: int(r.bytes), sha256: r.sha256 || null, drive_file_id: filed?.fileId ?? (r.fileId || null), drive_folder_id: filed?.folderId ?? null,
      received_at: ts(r.received), status, issues, ai_state: ex ? "done" : "skipped", ai_result: json(ex?.proposal),
      resolved_by: chk?.resolvedBy || null, deleted_at: ts(audit?.deletedAt ?? audit?.requestedAt), deleted_by: audit?.actor ?? null,
      deleted_reason: audit?.reason ?? null, source: "legacy", legacy: legacyBy(r.receipt),
    });
  }

  for (const r of S.Qualifications ?? []) {
    const c = clerkOf(r.owner);
    if (r.owner && !c) unmatched.add(`Qualifications: ${r.receipt} ${r.owner}`);
    const audit = r.state === "DELETED" ? json(r.filing) : null;
    uploads.push({
      receipt: r.receipt, clerk_id: c?.id ?? null, email: lc(r.owner) || "(deleted)", kind: "qualification",
      doc_type: r.type === "Other qualification" ? "Other" : r.type || null, mime: "application/pdf", bytes: int(r.bytes), sha256: r.sha256 || null,
      drive_file_id: r.fileId || null, drive_folder_id: r.folderId || null, received_at: ts(r.received),
      status: stateOf(r.state) === "deleted" ? "deleted" : r.filing === "Held" ? "needs_beamore" : r.filing === "Filed" ? "filed" : "received",
      ai_state: "skipped", deleted_at: ts(audit?.deletedAt ?? audit?.requestedAt), deleted_by: audit?.actor ?? null, deleted_reason: audit?.reason ?? null,
      source: "legacy", legacy: legacyBy(r.receipt),
    });
  }

  // ---- policies (only from certificates that weren't deleted, as the old portal did)
  const live = new Set(uploads.filter((u) => u.kind === "insurance" && u.status !== "deleted").map((u) => u.receipt));
  const certOwner = new Map((S.InsuranceCertificates ?? []).map((r) => [r.receipt, r.owner]));
  const policies = [];
  for (const p of S.InsurancePolicies ?? []) {
    if (!live.has(p.receipt)) continue;
    const c = clerkOf(p.owner || certOwner.get(p.receipt));
    if (!c) { unmatched.add(`InsurancePolicies: ${p.receipt} ${p.owner}`); continue; }
    policies.push({
      receipt: p.receipt, clerk_id: c.id, type: TYPE[p.type] ?? "other", description: p.description || null, insured_name: p.insuredName || null,
      cover_pence: int(p.coverPence), currency: p.currency || "GBP", starts: day(p.starts), expires: day(p.expires),
      evidence: p.evidence ? { text: p.evidence } : null, checked_at: ts(p.checkedAt), checked_by: p.checkedBy === "Automatic insurance document checks" ? "AI (old portal)" : p.checkedBy || null, source: "legacy",
    });
  }

  // ---- invoice checks, expectations, company links, Personnel folders
  const invChecks = (S.InvoiceChecks ?? []).map((r) => ({ receipt: r.receipt, supplier: r.supplierKey, invoice_number: r.invoiceNumber, invoice_date: day(r.invoiceDate), period: r.period, net_pence: int(r.netPence), vat_pence: int(r.vatPence), gross_pence: int(r.grossPence), vat_checked: bool(r.vatChecked), cis: r.cis === "Specialist review required", checked_at: ts(r.checkedAt), checked_by: r.checkedBy }));
  const expectations = [];
  for (const r of S.Expectations ?? []) {
    const c = clerkOf(r.email, r.name);
    if (!c) { unmatched.add(`Expectations: ${r.email}`); continue; }
    expectations.push({ period: r.period, clerk_id: c.id, expected: bool(r.expected), updated_at: ts(r.updatedAt) ?? new Date().toISOString(), updated_by: r.updatedBy || "old portal" });
  }
  const companies = (S.CompanyMappings ?? []).map((r) => ({
    legacy_id: r.id, clerk_id: r.email ? clerkOf(r.email)?.id ?? null : null, email: lc(r.email) || null, company_name: r.companyName,
    xero_contact_id: r.contactId || null, xero_tenant_id: r.tenantId || null, relationship: r.relationship || null, status: r.status || null,
    evidence: r.evidence || null, created_at: ts(r.createdAt), created_by: r.createdBy || null, updated_at: ts(r.updatedAt), updated_by: r.updatedBy || null,
  }));
  const folders = [];
  for (const r of S.InsuranceFolders ?? []) {
    const c = clerkOf(r.email, r.name);
    if (c && r.personnelId) folders.push({ clerk_id: c.id, documents_folder_id: r.personnelId });
  }

  say(`clerks to update ${clerkUpdates.length} (portal access ${clerkUpdates.filter((c) => c.portal_access).length})`);
  say(`uploads ${uploads.length}: ` + ["invoice", "company_invoice", "insurance", "qualification"].map((k) => `${k} ${uploads.filter((u) => u.kind === k).length} (${uploads.filter((u) => u.kind === k && u.status !== "deleted").length} live)`).join(", "));
  say(`policies ${policies.length}, invoice checks ${invChecks.length}, expectations ${expectations.length}, company links ${companies.length}, Personnel folders ${folders.length}`);
  if (unmatched.size) say("NOT MATCHED to a clerk:\n  " + [...unmatched].join("\n  "));
  if (!write) return;

  for (const c of clerkUpdates) { const { id, ...v } = c; const { error } = await db.from("clerks").update(v).eq("id", id); if (error) throw new Error("clerk " + error.message); }
  for (const f of folders) {
    await db.from("clerk_compliance").upsert({ clerk_id: f.clerk_id }, { onConflict: "clerk_id", ignoreDuplicates: true });
    await db.from("clerk_compliance").update({ documents_folder_id: f.documents_folder_id }).eq("clerk_id", f.clerk_id).is("documents_folder_id", null);
  }
  for (const u of uploads) u.issues ??= []; // bulk upserts fill missing keys with null
  { // keep file names and folders already looked up in Drive on an earlier run
    const { data: had } = await db.from("portal_uploads").select("receipt,file_name,drive_folder_id").eq("source", "legacy");
    const h = new Map((had ?? []).map((r) => [r.receipt, r]));
    for (const u of uploads) { const o = h.get(u.receipt); u.file_name ??= o?.file_name ?? null; u.drive_folder_id ??= o?.drive_folder_id ?? null; }
  }
  const { error: ue } = await db.from("portal_uploads").upsert(uploads, { onConflict: "receipt" });
  if (ue) throw new Error("uploads " + ue.message);
  const { data: ids } = await db.from("portal_uploads").select("id,receipt").eq("source", "legacy");
  const idOf = new Map(ids.map((r) => [r.receipt, r.id]));
  await db.from("insurance_policies").delete().eq("source", "legacy");
  const pol = policies.map(({ receipt, ...p }) => ({ ...p, upload_id: idOf.get(receipt) ?? null }));
  if (pol.length) { const { error } = await db.from("insurance_policies").insert(pol); if (error) throw new Error("policies " + error.message); }
  const ic = invChecks.filter((r) => idOf.has(r.receipt)).map(({ receipt, ...r }) => ({ ...r, upload_id: idOf.get(receipt) }));
  if (ic.length) { const { error } = await db.from("portal_invoice_checks").upsert(ic); if (error) throw new Error("invoice checks " + error.message); }
  if (expectations.length) { const { error } = await db.from("portal_expectations").upsert(expectations); if (error) throw new Error("expectations " + error.message); }
  if (companies.length) { const { error } = await db.from("clerk_companies").upsert(companies, { onConflict: "legacy_id" }); if (error) throw new Error("companies " + error.message); }

  // insurance expiry dates feed the dashboard's renewal reminders (newest in-date policy of each type)
  const latest = new Map();
  for (const p of pol) {
    const k = `${p.clerk_id}|${p.type}`;
    if (!p.expires) continue;
    if (!latest.has(k) || latest.get(k).expires < p.expires) latest.set(k, p);
  }
  for (const p of latest.values()) {
    const col = p.type === "PI" ? "pi_insurance_expiry" : p.type === "PL" ? "pl_insurance_expiry" : null;
    if (!col) continue;
    await db.from("clerk_compliance").upsert({ clerk_id: p.clerk_id }, { onConflict: "clerk_id", ignoreDuplicates: true });
    await db.from("clerk_compliance").update({ [col]: p.expires }).eq("clerk_id", p.clerk_id);
  }
  await db.from("portal_audit").insert({ actor: "import", action: "legacy-import", detail: { uploads: uploads.length, policies: pol.length } });
  say("imported");
}
