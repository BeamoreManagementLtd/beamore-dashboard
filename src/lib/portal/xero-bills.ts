import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { xeroClient } from "@/lib/xero";
import { driveClient } from "@/lib/google";
import { projectCategories, isEducation } from "@/lib/xero-tracking";
import { resolveSites } from "./diary-writer";

/**
 * A clerk's invoice uploaded on the portal becomes a DRAFT bill in Xero once the diary step has run, whether it went in
 * or is held there for a person (Ronan, 25 Nov 2026:
 * "how come their invoice wasn't put onto Xero straight away"). Set out the way the office enters them by hand: account
 * 464, prices excluding VAT, VAT at 20% only when the clerk charges it (no CIS at Beamore), one line per job
 * ("Brunswick School Woodhouse - October 2026", days x day rate) tagged with the job's project, the clerk's invoice
 * number as the bill number, the due date left to the supplier's own terms in Xero, and the invoice PDF attached.
 * Only a draft: nothing is approved or paid until someone checks it in Xero. Anything that doesn't add up waits for a
 * person. The outcome is kept on the upload (ai_result.xero).
 */
export type BillOutcome = { state: "created" | "exists" | "needs_review" | "not_applicable"; note: string; bill_id?: string; number?: string };

const ACCOUNT = "464";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const FROM = "2026-11-01"; // invoices uploaded before bills were made here were entered by hand

type Ai = {
  invoice_number?: string | null; invoice_date?: string | null; period?: string | null; supplier?: string | null;
  net_gbp?: number | null; vat_gbp?: number | null; gross_gbp?: number | null;
  lines?: { text: string; amount_gbp: number | null }[]; expenses?: { text: string; amount_gbp: number | null }[];
  visits?: { date: string; site: string; half_days: number }[];
  xero?: BillOutcome & { at: string };
};

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !/^(school|academy|college|primary|days?|from|with)$/.test(w));
const money = (n: number) => Math.round(n * 100) / 100;

export async function makeBill(admin: SupabaseClient, uploadId: string): Promise<BillOutcome> {
  const { data: u } = await admin.from("portal_uploads").select("id,clerk_id,file_name,mime,drive_file_id,ai_result,kind,clerks(name)").eq("id", uploadId).single();
  if (!u?.clerk_id) return { state: "not_applicable", note: "No clerk for this invoice" };
  const ai = (u.ai_result ?? {}) as Ai;
  // no number on the invoice itself: the one in the file name (Ronan, 26 Nov 2026: Margaret's "Invoice 42 - November
  // 2026.pdf", Conor's "BML 43.pdf")
  const number = (ai.invoice_number ?? "").trim() || numberFromFileName(u.file_name ?? "");
  // a timesheet with no money on it (Wayne Gates: Clipper invoice for his work later) isn't a bill
  if (/time\s*sheet/i.test(u.file_name ?? "") && !Number(ai.net_gbp ?? 0) && !(ai.lines ?? []).some((l) => Number(l.amount_gbp ?? 0) > 0))
    return { state: "not_applicable", note: "A timesheet, not an invoice: the company will invoice for it" };
  if (!number) return { state: "needs_review", note: "The invoice has no invoice number, so it wasn't put into Xero: please enter it by hand" };

  // the supplier: a company linked to the clerk in Xero, their own or one they work through (e.g. Mark Prickett through
  // Amrin Resources, Ronan 26 Nov 2026); the one named on the invoice first, then their own
  const { data: cos } = await admin.from("clerk_companies").select("company_name,xero_contact_id,kind").eq("clerk_id", u.clerk_id).eq("status", "Enabled").not("xero_contact_id", "is", null);
  if (!cos?.length) return { state: "needs_review", note: "This clerk's company isn't linked to a Xero contact yet (Clerk portal → Company links)" };
  const sup = (ai.supplier ?? "").toLowerCase();
  // the closest name first ("Damian Breen - Account 2" over "Damian Breen" when the invoice says Account 2)
  const named = cos.filter((c) => sup && (sup.includes(c.company_name.toLowerCase()) || c.company_name.toLowerCase().includes(sup)))
    .sort((x, y) => Number(y.company_name.toLowerCase() === sup) - Number(x.company_name.toLowerCase() === sup) || Number(sup.includes(y.company_name.toLowerCase())) * y.company_name.length - Number(sup.includes(x.company_name.toLowerCase())) * x.company_name.length);
  const co = named[0] ?? cos.find((c) => c.kind === "own") ?? cos[0];
  const xero = await xeroClient(admin);

  // already in Xero (entered by hand, or made here before)?
  const safe = number.replace(/"/g, "");
  const have = await xero<{ Invoices: { InvoiceID: string; InvoiceNumber: string; Status: string }[] }>("Invoices", { where: `Type=="ACCPAY" AND Contact.ContactID==Guid("${co.xero_contact_id}") AND InvoiceNumber=="${safe}"` });
  const dup = have.Invoices.find((i) => i.Status !== "DELETED" && i.Status !== "VOIDED");
  if (dup) return { state: "exists", note: `Already in Xero as bill ${dup.InvoiceNumber} (${dup.Status.toLowerCase()})`, bill_id: dup.InvoiceID, number: dup.InvoiceNumber };

  // the clerk's last bill is the starting point, like "Copy" in Xero (Ronan, 25 Nov 2026): its account, VAT setting,
  // payment terms and reference style carry over; the lines, number, date and PDF are this invoice's
  type XLine = { AccountCode?: string; TaxType?: string; LineAmount?: number };
  type XBill = { InvoiceID: string; InvoiceNumber: string; Status: string; Reference?: string; LineAmountTypes?: string; DateString?: string; DueDateString?: string; LineItems?: XLine[] };
  const prev = (await xero<{ Invoices: XBill[] }>("Invoices", { where: `Type=="ACCPAY" AND Contact.ContactID==Guid("${co.xero_contact_id}") AND Status!="DELETED" AND Status!="VOIDED"`, order: "Date DESC", page: 1 })).Invoices[0];
  const prevFull = prev ? (await xero<{ Invoices: XBill[] }>(`Invoices/${prev.InvoiceID}`)).Invoices[0] : null;
  const prevLine = (prevFull?.LineItems ?? []).find((l) => (l.LineAmount ?? 0) > 0) ?? prevFull?.LineItems?.[0];
  const termDays = prevFull?.DateString && prevFull?.DueDateString ? Math.round((Date.parse(prevFull.DueDateString) - Date.parse(prevFull.DateString)) / 86400000) : null;

  // the jobs: each site wording on the invoice -> its diary site -> the project
  const period = /^\d{4}-\d{2}$/.test(ai.period ?? "") ? ai.period! : (ai.invoice_date ?? new Date().toISOString()).slice(0, 7);
  const monthLabel = `${MONTHS[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}`;
  const wordings = [...new Set((ai.visits ?? []).map((v) => v.site.trim()).filter(Boolean))];
  const { map } = wordings.length ? await resolveSites(admin, u.clerk_id, wordings) : { map: new Map<string, string | null>() };
  const { data: projects } = await admin.from("projects").select("id,name,display_name,diary_aliases,is_dfe,folder_kind").not("diary_aliases", "is", null);
  const projectOfSite = (site: string | null | undefined) => site ? (projects ?? []).find((p) => (p.diary_aliases as string[] ?? []).some((a) => a.toLowerCase() === site.toLowerCase())) ?? null : null;
  const jobs = wordings.map((w) => ({ wording: w, project: projectOfSite(map.get(w)) }));

  const cats = await projectCategories(xero);
  const optionFor = (p: NonNullable<(typeof jobs)[number]["project"]>) => {
    const cat = isEducation(p) ? cats.education : cats.other;
    const name = (p.display_name ?? p.name) as string;
    const opt = cat?.Options.find((o) => o.Status === "ACTIVE" && o.Name.toLowerCase() === name.toLowerCase());
    return cat && opt ? [{ Name: cat.Name, Option: opt.Name }] : undefined;
  };

  const vat = Number(ai.vat_gbp ?? 0) > 0;
  // VAT as on the last bill when it agrees with this invoice (charged or not); otherwise this invoice decides
  const prevVat = prevLine?.TaxType && !/^(NONE|EXEMPT|ZERO)/i.test(prevLine.TaxType) ? prevLine.TaxType : null;
  const tax = vat ? (prevVat ?? "INPUT2") : (prevLine?.TaxType && !prevVat ? prevLine.TaxType : "NONE");
  const account = prevLine?.AccountCode || ACCOUNT;
  type Line = { Description: string; Quantity: number; UnitAmount: number; AccountCode: string; TaxType: string; Tracking?: { Name: string; Option: string }[] };
  const lines: Line[] = [];
  for (const l of ai.lines ?? []) {
    const amount = Number(l.amount_gbp ?? 0);
    if (!(amount > 0)) continue;
    // "4 days @ £310": days and day rate, as entered by hand
    const m = /(\d+(?:\.\d+)?)\s*(?:days?|x)\b[^@£]*@\s*£?\s*([\d,]+(?:\.\d+)?)/i.exec(l.text);
    const qty = m ? Number(m[1]) : 1, rate = m ? Number(m[2].replace(/,/g, "")) : amount;
    const ok = Math.abs(qty * rate - amount) < 0.02;
    const t = l.text.toLowerCase();
    const job = jobs.find((j) => t.includes(j.wording.toLowerCase())) ?? jobs.find((j) => words(j.wording).some((w) => t.includes(w))) ?? (jobs.length === 1 ? jobs[0] : undefined);
    const p = job?.project ?? null;
    lines.push({
      Description: p ? `${p.display_name ?? p.name} - ${monthLabel}` : l.text,
      Quantity: ok ? qty : 1, UnitAmount: ok ? rate : amount, AccountCode: account, TaxType: tax,
      ...(p && optionFor(p) ? { Tracking: optionFor(p) } : {}),
    });
  }
  // the only priced line is the total with VAT (Sunny Singh's CMS 13: £8,088 on the line, £6,740 + £1,348 VAT): the net
  if (vat && lines.length === 1 && ai.gross_gbp && ai.net_gbp && Math.abs(lines[0].Quantity * lines[0].UnitAmount - Number(ai.gross_gbp)) < 0.05) {
    lines[0].Quantity = 1; lines[0].UnitAmount = Number(ai.net_gbp);
  }
  for (const e of ai.expenses ?? []) {
    const amount = Number(e.amount_gbp ?? 0);
    // already one of the invoice's own lines (Mark Prickett's hotel): not twice
    if ((ai.lines ?? []).some((l) => Math.abs(Number(l.amount_gbp ?? 0) - amount) < 0.01)) continue;
    if (amount > 0) lines.push({ Description: `${e.text} - ${monthLabel}`, Quantity: 1, UnitAmount: amount, AccountCode: account, TaxType: tax });
  }
  if (!lines.length) return { state: "needs_review", note: "No amounts could be read from the invoice lines: please enter it in Xero by hand" };

  // the lines must come to the invoice's own total
  const net = money(lines.reduce((s, l) => s + l.Quantity * l.UnitAmount, 0));
  // VAT charged on the days but not the expenses (Mark Prickett's hotel, no VAT on it): those lines carry no VAT
  if (vat) {
    const exp = (ai.expenses ?? []).map((e) => Number(e.amount_gbp ?? 0)).filter((n) => n > 0);
    const noVat = lines.filter((l) => exp.some((n) => Math.abs(l.Quantity * l.UnitAmount - n) < 0.01));
    const rest = money(net - noVat.reduce((s, l) => s + l.Quantity * l.UnitAmount, 0));
    if (noVat.length && Math.abs(net * 0.2 - Number(ai.vat_gbp)) > 0.05 && Math.abs(rest * 0.2 - Number(ai.vat_gbp)) <= 0.05) for (const l of noVat) l.TaxType = "NONE";
  }
  const stated = Number(ai.net_gbp ?? (ai.gross_gbp && !vat ? ai.gross_gbp : NaN));
  if (Number.isFinite(stated) && Math.abs(net - stated) > 0.05) return { state: "needs_review", note: `The lines come to £${net}, but the invoice says £${stated} before VAT: please check and enter it in Xero by hand` };
  const vatable = money(lines.filter((l) => l.TaxType !== "NONE").reduce((s, l) => s + l.Quantity * l.UnitAmount, 0));
  if (vat && Math.abs(money(vatable * 0.2) - Number(ai.vat_gbp)) > 0.05) return { state: "needs_review", note: `VAT on the invoice is £${ai.vat_gbp}, not 20% of £${vatable}: please check and enter it in Xero by hand` };

  const date = /^\d{4}-\d{2}-\d{2}$/.test(ai.invoice_date ?? "") ? ai.invoice_date! : new Date(Date.UTC(+period.slice(0, 4), +period.slice(5), 0)).toISOString().slice(0, 10);
  const res = await xero.put<{ Invoices: { InvoiceID: string; InvoiceNumber: string; HasErrors?: boolean; ValidationErrors?: { Message: string }[] }[] }>("Invoices", {
    Invoices: [{
      Type: "ACCPAY", Status: "DRAFT", Contact: { ContactID: co.xero_contact_id }, InvoiceNumber: number, Date: date,
      // the same payment terms as the last bill (else the supplier's own terms in Xero)
      ...(termDays !== null && termDays >= 0 && termDays <= 90 ? { DueDate: new Date(Date.parse(date) + termDays * 86400000).toISOString().slice(0, 10) } : {}),
      // a reference that names the month is carried on with this month's
      ...(prevFull?.Reference && new RegExp(MONTHS.join("|")).test(prevFull.Reference) ? { Reference: prevFull.Reference.replace(new RegExp(`(${MONTHS.join("|")})\\s+\\d{4}`), monthLabel) } : {}),
      // the amounts here are before VAT
      LineAmountTypes: "Exclusive", LineItems: lines,
    }],
  }, { summarizeErrors: "false" });
  const bill = res.Invoices[0];
  if (!bill || bill.HasErrors) return { state: "needs_review", note: `Xero didn't take the bill: ${(bill?.ValidationErrors ?? []).map((v) => v.Message).join("; ") || "no reason given"}` };

  // the clerk's invoice attached, so whoever approves it can see what was billed
  let attached = "";
  if (u.drive_file_id) {
    try {
      const g = await driveClient(admin);
      await xero.attach(`Invoices/${bill.InvoiceID}`, u.file_name, Buffer.from(await g.download(u.drive_file_id)), u.mime || "application/pdf");
    } catch (e) { attached = ` (the invoice file couldn't be attached: ${e instanceof Error ? e.message.slice(0, 80) : "error"})`; }
  }
  return { state: "created", note: `Draft bill ${number} for £${net}${vat ? ` + £${ai.vat_gbp} VAT` : ""} made in Xero${prev ? ` from ${prev.InvoiceNumber}` : ""}, waiting for approval${attached}`, bill_id: bill.InvoiceID, number };
}

/** Every 15 minutes: invoices now in the diary that haven't been made into a Xero bill yet. */
export async function makePendingBills(admin: SupabaseClient) {
  const { data } = await admin.from("portal_uploads").select("id,ai_result").in("kind", ["invoice", "company_invoice"]).in("diary_state", ["written", "needs_review"])
    .is("deleted_at", null).neq("status", "deleted").gte("received_at", FROM).order("received_at").limit(40);
  let made = 0;
  // also tried again: ones stopped only because the company wasn't linked yet (it may be linked now)
  const notLinked = (x: Ai["xero"]) => x?.state === "needs_review" && x.note.includes("isn't linked to a Xero contact");
  for (const r of (data ?? []).filter((x) => { const b = (x.ai_result as Ai | null)?.xero; return !b || notLinked(b); })
    .sort((a, b) => Number(!!(a.ai_result as Ai | null)?.xero) - Number(!!(b.ai_result as Ai | null)?.xero)).slice(0, 8)) {
    let o: BillOutcome;
    try { o = await makeBill(admin, r.id); }
    catch (e) { o = { state: "needs_review", note: `Couldn't make the Xero bill: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` }; }
    const { data: cur } = await admin.from("portal_uploads").select("ai_result").eq("id", r.id).single();
    await admin.from("portal_uploads").update({ ai_result: { ...((cur?.ai_result ?? {}) as object), xero: { ...o, at: new Date().toISOString() } } }).eq("id", r.id);
    if (o.state === "created") made++;
  }
  // bills made before the attachment permission was given: attach the invoice now
  const { data: noFile } = await admin.from("portal_uploads").select("id,file_name,mime,drive_file_id,ai_result").in("kind", ["invoice", "company_invoice"]).eq("ai_result->xero->>state", "created").like("ai_result->xero->>note", "%couldn't be attached%").limit(10);
  if (noFile?.length) {
    const xero = await xeroClient(admin);
    const g = await driveClient(admin);
    for (const r of noFile) {
      const x = (r.ai_result as Ai).xero!;
      if (!x.bill_id || !r.drive_file_id) continue;
      try {
        await xero.attach(`Invoices/${x.bill_id}`, r.file_name, Buffer.from(await g.download(r.drive_file_id)), r.mime || "application/pdf");
        await admin.from("portal_uploads").update({ ai_result: { ...(r.ai_result as object), xero: { ...x, note: `${x.note.split(" (the invoice file couldn't be attached")[0]} (invoice attached)`, at: new Date().toISOString() } } }).eq("id", r.id);
      } catch { break; } // still not allowed: try again next time
    }
  }
  return made;
}

/** An invoice number in the file name: "Invoice 42 - November 2026.pdf" -> "42", "BML 43.pdf" -> "BML 43". */
export function numberFromFileName(name: string) {
  const base = name.replace(/\.[a-z0-9]+$/i, "").trim();
  if (/^[A-Z]{2,6}[\s\-]?\d{1,6}$/i.test(base)) return base;
  const m = /\binv(?:oice)?\.?\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z]*[-\/]?\d[\w\-\/.]*)/i.exec(base);
  if (m) return m[1].replace(/[.\-]+$/, "");
  return "";
}
