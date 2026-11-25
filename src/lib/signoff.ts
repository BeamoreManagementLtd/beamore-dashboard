import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { xeroClient, type XeroGet } from "@/lib/xero";
import { projectMatcher } from "@/lib/project-match";
import { siteKey } from "@/lib/site-key.mjs";
import { projectCategories, isEducation, TRACKING_NAMES } from "@/lib/xero-tracking";

/**
 * Monthly sign-off (decision 6): compare the diary's grey (planned) and salmon (charged) days per project, then prepare
 * DRAFT Xero invoices by copying each project's previous invoice with this month's charged days. Nothing is approved or
 * sent from the dashboard: drafts wait in Xero for Ronan.
 */

/**
 * When a client invoice is due. Usually the same terms as the last invoice copied; some clients have fixed terms:
 *  - The Forum Hotel (Ronan, 25 Nov 2026): billed at the end of the month, paid on the 5th of the month after next,
 *    e.g. November's invoice (dated 30 November) is due 5 January
 */
function dueDate(project: string, contact: string, end: string, termDays: number) {
  if (/forum/i.test(`${project} ${contact}`)) {
    const d = new Date(`${end}T00:00:00Z`);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 5)).toISOString().slice(0, 10);
  }
  return addDays(end, termDays);
}

export const monthStart = (ym: string) => `${ym.slice(0, 7)}-01`;
const lastDay = (m: string) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
export const monthLabel = (m: string) => new Date(m + "T00:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const shortLabel = (m: string) => new Date(m + "T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

export type MonthRow = { projectId: string | null; name: string; client: string | null; plannedB: number; plannedMe: number; chargedB: number; chargedMe: number };

/** Planned vs charged days per project for one month (works with either the user's or the service client). */
export async function monthComparison(db: SupabaseClient, m: string): Promise<MonthRow[]> {
  const [{ data: days, error }, { data: projects }] = await Promise.all([
    db.rpc("month_project_days", { m }),
    db.from("projects").select("id,display_name,clients(name)"),
  ]);
  if (error) throw new Error(error.message);
  const pmap = new Map((projects ?? []).map((p) => [p.id, p]));
  const rows = new Map<string, MonthRow>();
  for (const d of (days ?? []) as { project_id: string | null; kind: string; side: string; days: number }[]) {
    const key = d.project_id ?? "none";
    const p = d.project_id ? pmap.get(d.project_id) : null;
    const r = rows.get(key) ?? {
      projectId: d.project_id, name: p?.display_name ?? "Sites not linked to a project",
      client: (p?.clients as unknown as { name: string } | null)?.name ?? null, plannedB: 0, plannedMe: 0, chargedB: 0, chargedMe: 0,
    };
    const n = Number(d.days);
    const field = `${d.side === "planned" ? "planned" : "charged"}${d.kind === "me" ? "Me" : "B"}` as "plannedB" | "plannedMe" | "chargedB" | "chargedMe";
    r[field] += n;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => (a.projectId ? 0 : 1) - (b.projectId ? 0 : 1) || a.name.localeCompare(b.name));
}

type XLine = { Description?: string; Quantity?: number; UnitAmount?: number; AccountCode?: string; TaxType?: string; ItemCode?: string; Tracking?: { Name: string; Option: string }[] };
type XInv = {
  InvoiceID: string; InvoiceNumber: string; Reference?: string; Status: string; Type: string; LineAmountTypes?: string;
  Contact: { ContactID: string; Name: string }; DateString?: string; DueDateString?: string; LineItems?: XLine[]; SubTotal?: number;
};

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const SHORT = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec";
const retext = (s: string | undefined, m: string, qty?: number) =>
  (s ?? "")
    .replace(new RegExp(`\\b(${MONTHS})\\s+20\\d\\d\\b`, "g"), monthLabel(m))
    .replace(new RegExp(`\\b(${SHORT})\\s+20\\d\\d\\b`, "g"), shortLabel(m))
    .replace(/\b\d+(\.\d+)?no inspections?\b/gi, (w) => (qty == null ? w : `${qty}no inspection${qty === 1 ? "" : "s"}`));
const priced = (l: XLine) => !!l.Quantity && !!l.UnitAmount;
const isMe = (s?: string) => /m\s*&\s*e/i.test(s ?? "");

async function allInvoices(get: XeroGet, from: string) {
  const [y, mo, d] = from.split("-").map(Number);
  const out: XInv[] = [];
  for (let page = 1; page < 30; page++) {
    const r = await get<{ Invoices: XInv[] }>("Invoices", {
      where: `Type=="ACCREC" AND Date>=DateTime(${y},${mo},${d})`, Statuses: "DRAFT,SUBMITTED,AUTHORISED,PAID", page, pageSize: 100, order: "Date DESC",
    });
    out.push(...r.Invoices);
    if (r.Invoices.length < 100) break;
  }
  return out;
}

/**
 * Builds draft invoices for month m and stores them (replacing earlier unsent drafts for that month).
 * With test: true, for a month already invoiced, it builds each draft from the invoice before and compares it with
 * what was actually invoiced, so you can see how close the drafts are. Nothing can be created from a test.
 */
export async function prepareDrafts(admin: SupabaseClient, m: string, { test = false } = {}) {
  const end = lastDay(m);
  const get = await xeroClient(admin);
  const [rows, { data: projects }, { data: rates }, { data: linked }, invoices] = await Promise.all([
    monthComparison(admin, m),
    admin.from("projects").select("id,name,display_name,diary_aliases,is_dfe,folder_kind"),
    admin.from("rates").select("site_as_typed,charge"),
    admin.from("invoices").select("number,project_id").not("project_id", "is", null),
    allInvoices(get, addDays(m, -150)),
  ]);
  const match = projectMatcher(projects ?? []);
  // Xero project tracking (if set up): drafts are tagged in "Education projects" or "Other projects"
  const cats = await projectCategories(get).catch(() => ({ education: null, other: null }));
  const optionsOf = (c: typeof cats.education) => new Map((c?.Options ?? []).filter((o) => o.Status === "ACTIVE").map((o) => [o.Name.toLowerCase(), o.Name]));
  const tracking = { education: { cat: cats.education, options: optionsOf(cats.education) }, other: { cat: cats.other, options: optionsOf(cats.other) } };
  // links already made (by the Xero sync, the diary's invoice table or by hand) win; then every part of the reference
  // ("FS1018 - Wisbech", "BLMS0547 - Paignton"), then the line descriptions
  const known = new Map((linked ?? []).map((i) => [i.number, i.project_id as string]));
  const projectOf = (i: XInv) =>
    known.get(i.InvoiceNumber) ??
    (i.Reference ?? "").split(/\s+[-–]\s+/).map((part) => match.fromReference(part)).find(Boolean) ??
    match.fromText(i.Reference) ??
    (i.LineItems ?? []).map((l) => match.fromReference(l.Description) ?? match.fromText(l.Description)).find(Boolean) ?? null;

  // charge rates from the diary's Rates tab, by project and kind
  const rateBy = new Map<string, number>();
  const pById = new Map((projects ?? []).map((p) => [p.id, p]));
  for (const r of rates ?? []) {
    if (!r.charge) continue;
    const pid = match.byKey.get(siteKey(r.site_as_typed));
    if (pid) rateBy.set(`${pid}|${isMe(r.site_as_typed) ? "me" : "b"}`, Number(r.charge));
  }

  // previous invoices per project (newest first), invoices already raised for this month, highest number per prefix
  const byProject = new Map<string, XInv[]>();
  for (const i of invoices) { const pid = projectOf(i); if (pid) byProject.set(pid, [...(byProject.get(pid) ?? []), i]); }
  const highest = new Map<string, { n: number; width: number }>();
  for (const i of invoices) {
    const mm = /^([A-Z0-9]+)-(\d+)$/i.exec(i.InvoiceNumber ?? "");
    if (!mm) continue;
    const cur = highest.get(mm[1]);
    if (!cur || +mm[2] > cur.n) highest.set(mm[1], { n: +mm[2], width: mm[2].length });
  }
  const nextNumber = (prefix: string) => {
    const h = highest.get(prefix) ?? { n: 0, width: 3 };
    h.n += 1; highest.set(prefix, h);
    return `${prefix}-${String(h.n).padStart(h.width, "0")}`;
  };

  const drafts = [];
  for (const r of rows) {
    if (!r.projectId || r.chargedB + r.chargedMe === 0) continue;
    const p = pById.get(r.projectId)!;
    const history = (byProject.get(r.projectId) ?? []).sort((a, b) => (b.DateString ?? "").localeCompare(a.DateString ?? ""));
    const dated = (i: XInv) => (i.DateString ?? "").slice(0, 10);
    const already = history.find((i) => (dated(i) >= m && dated(i) <= addDays(end, 20)) || (i.Reference ?? "").includes(monthLabel(m)));
    const base = { month: m, project_id: r.projectId, days_building: r.chargedB, days_me: r.chargedMe, warnings: [] as string[] };
    if (already && !test) { drafts.push({ ...base, status: "skipped", invoice_number: already.InvoiceNumber, contact_name: already.Contact.Name, reference: already.Reference, note: `Already in Xero (${already.Status.toLowerCase()})` }); continue; }
    if (test && !already) { drafts.push({ ...base, status: "skipped", note: "Check: nothing in Xero for this month to compare with" }); continue; }
    const tpl = history.find((i) => dated(i) < m && i.Status !== "DRAFT" && (i.LineItems ?? []).some(priced));
    if (!tpl) { drafts.push({ ...base, status: "skipped", note: "No earlier invoice in the last 5 months to copy: raise this one by hand" }); continue; }

    const warnings: string[] = [];
    const want = { b: r.chargedB, me: r.chargedMe };
    const used = { b: false, me: false };
    const lines: XLine[] = [];
    for (const l of tpl.LineItems ?? []) {
      if (!priced(l)) { lines.push({ Description: retext(l.Description, m) }); continue; }
      // expenses (e.g. Northumberland's hotel stays) change month to month: don't copy them, flag them
      if (/hotel|accommodation|travel|mileage|expense|parking|subsistence|train|fuel/i.test(l.Description ?? "")) {
        warnings.push(`Last invoice included "${(l.Description ?? "").split("\n")[0]}" £${Math.round(l.Quantity! * l.UnitAmount!)}: add this month's if needed`);
        continue;
      }
      const kind = isMe(l.Description) ? "me" : "b";
      if (used[kind] || want[kind] === 0) continue;
      used[kind] = true;
      const rate = rateBy.get(`${r.projectId}|${kind}`) ?? l.UnitAmount!;
      if (rate !== l.UnitAmount) warnings.push(`${kind === "me" ? "M&E" : "Building"} rate £${rate} from the Rates tab; last invoice charged £${l.UnitAmount}`);
      lines.push({ ...l, Description: retext(l.Description, m, want[kind]), Quantity: want[kind], UnitAmount: rate });
    }
    for (const kind of ["b", "me"] as const) {
      if (want[kind] === 0 || used[kind]) continue;
      const like = (tpl.LineItems ?? []).find(priced)!;
      const rate = rateBy.get(`${r.projectId}|${kind}`) ?? like.UnitAmount!;
      const desc = kind === "me" ? `M&E ${like.Description ?? ""}` : (like.Description ?? "").replace(/^M\s*&\s*E\s*/i, "");
      lines.push({ ...like, Description: retext(desc, m, want[kind]), Quantity: want[kind], UnitAmount: rate });
      warnings.push(`New ${kind === "me" ? "M&E" : "building"} line (the last invoice didn't have one): check the wording and rate`);
    }
    if (r.plannedB + r.plannedMe > 0 && (r.plannedB !== r.chargedB || r.plannedMe !== r.chargedMe))
      warnings.push(`Planned ${r.plannedB + r.plannedMe} days, charged ${r.chargedB + r.chargedMe}`);
    const tplMonth = (tpl.DateString ?? "").slice(0, 7);
    if (tplMonth < addDays(m, -1).slice(0, 7)) warnings.push(`Copied from ${tpl.InvoiceNumber} (${tplMonth}), not last month`);

    const prefix = /^([A-Z0-9]+)-/i.exec(tpl.InvoiceNumber)?.[1] ?? "INV";
    const termDays = Math.round((Date.parse(tpl.DueDateString ?? tpl.DateString ?? "") - Date.parse(tpl.DateString ?? "")) / 86400000) || 30;
    const reference = new RegExp(MONTHS).test(tpl.Reference ?? "") || new RegExp(SHORT).test(tpl.Reference ?? "")
      ? retext(tpl.Reference, m) : `${(tpl.Reference ?? p.name).split(/\s+[-–]\s+/)[0]} - ${monthLabel(m)}`;
    const number = nextNumber(prefix);
    const t = isEducation(p) ? tracking.education : tracking.other;
    const option = t.options.get(p.display_name.toLowerCase());
    if (t.cat && !option) warnings.push(`No "${t.cat.Name}" tracking option for ${p.display_name} in Xero yet`);
    // replace any project tag copied from the old invoice with the right category's option
    const tagged = (l: XLine) => option && t.cat ? [...(l.Tracking ?? []).filter((x) => !TRACKING_NAMES.includes(x.Name)), { Name: t.cat.Name, Option: option }] : l.Tracking?.filter((x) => !TRACKING_NAMES.includes(x.Name));
    const payload = {
      Type: "ACCREC", Status: "DRAFT", Contact: { ContactID: tpl.Contact.ContactID }, InvoiceNumber: number, Reference: reference,
      Date: end, DueDate: dueDate(p.name, tpl.Contact.Name, end, termDays), LineAmountTypes: tpl.LineAmountTypes ?? "Exclusive",
      LineItems: lines.map((l) => ({
        Description: l.Description, ...(priced(l) ? { Quantity: l.Quantity, UnitAmount: l.UnitAmount, AccountCode: l.AccountCode, TaxType: l.TaxType } : {}),
        ...(l.ItemCode && priced(l) ? { ItemCode: l.ItemCode } : {}),
        ...(priced(l) && tagged(l)?.length ? { Tracking: tagged(l)!.map((t) => ({ Name: t.Name, Option: t.Option })) } : {}),
      })),
    };
    const total = lines.filter(priced).reduce((s, l) => s + l.Quantity! * l.UnitAmount!, 0);
    if (test && already) {
      const actual = Number(already.SubTotal ?? 0), diff = Math.round((total - actual) * 100) / 100;
      drafts.push({
        ...base, status: "skipped", invoice_number: already.InvoiceNumber, contact_name: tpl.Contact.Name, reference, total_net: total,
        lines: lines.map((l) => ({ text: l.Description, qty: l.Quantity ?? null, rate: l.UnitAmount ?? null })), warnings,
        note: diff === 0 ? `Check: matches ${already.InvoiceNumber} (£${actual})` : `Check: ${already.InvoiceNumber} was £${actual}, draft £${total} (${diff > 0 ? "+" : ""}${diff})`,
      });
      continue;
    }
    drafts.push({
      ...base, status: "prepared", invoice_number: number, contact_name: tpl.Contact.Name, reference, total_net: total,
      lines: lines.map((l) => ({ text: l.Description, qty: l.Quantity ?? null, rate: l.UnitAmount ?? null })),
      payload, warnings, note: `Copied from ${tpl.InvoiceNumber}`,
    });
  }

  await admin.from("invoice_drafts").delete().eq("month", m).in("status", ["prepared", "skipped", "error"]);
  if (drafts.length) {
    const { error } = await admin.from("invoice_drafts").insert(drafts);
    if (error) throw new Error(error.message);
  }
  return {
    prepared: drafts.filter((d) => d.status === "prepared").length, skipped: drafts.filter((d) => d.status === "skipped").length,
    matched: drafts.filter((d) => d.note?.startsWith("Check: matches")).length, compared: drafts.filter((d) => d.note?.startsWith("Check:") && !d.note.includes("nothing in Xero")).length,
  };
}

/** Sends the prepared drafts to Xero as DRAFT invoices and records the month as signed off. */
export async function createDrafts(admin: SupabaseClient, m: string, userId: string) {
  const { data: ready, error } = await admin.from("invoice_drafts").select("id,payload,invoice_number").eq("month", m).eq("status", "prepared");
  if (error) throw new Error(error.message);
  if (!ready?.length) return { created: 0, failed: 0 };
  const xero = await xeroClient(admin);
  let created = 0, failed = 0;
  for (let i = 0; i < ready.length; i += 25) {
    const batch = ready.slice(i, i + 25);
    let res: { Invoices: { InvoiceID: string; InvoiceNumber: string; HasErrors?: boolean; ValidationErrors?: { Message: string }[] }[] };
    try {
      res = await xero.put("Invoices", { Invoices: batch.map((b) => b.payload) }, { summarizeErrors: "false" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const hint = / 40[13] /.test(msg) ? "Xero refused: reconnect Xero on the Finance page to allow draft invoices. " : "";
      for (const b of batch) await admin.from("invoice_drafts").update({ status: "error", note: hint + msg.slice(0, 300) }).eq("id", b.id);
      failed += batch.length;
      continue;
    }
    for (const [j, inv] of res.Invoices.entries()) {
      const b = batch[j];
      if (inv.HasErrors) {
        failed++;
        await admin.from("invoice_drafts").update({ status: "error", note: (inv.ValidationErrors ?? []).map((v) => v.Message).join("; ") }).eq("id", b.id);
      } else {
        created++;
        await admin.from("invoice_drafts").update({ status: "created", xero_invoice_id: inv.InvoiceID, invoice_number: inv.InvoiceNumber }).eq("id", b.id);
      }
    }
  }
  if (created) await admin.from("month_signoffs").upsert({ month: m, approved_by: userId, approved_at: new Date().toISOString() });
  return { created, failed };
}
