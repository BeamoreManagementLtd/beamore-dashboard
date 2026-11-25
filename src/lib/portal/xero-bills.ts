import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { xeroClient } from "@/lib/xero";
import { driveClient } from "@/lib/google";
import { projectCategories, isEducation } from "@/lib/xero-tracking";
import { resolveSites } from "./diary-writer";

/**
 * A clerk's invoice uploaded on the portal becomes a DRAFT bill in Xero once it's in the diary (Ronan, 25 Nov 2026:
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
  const number = (ai.invoice_number ?? "").trim();
  if (!number) return { state: "needs_review", note: "The invoice has no invoice number, so it wasn't put into Xero: please enter it by hand" };

  // the supplier: the clerk's own company linked to Xero (the one named on the invoice when there are several)
  const { data: cos } = await admin.from("clerk_companies").select("company_name,xero_contact_id").eq("clerk_id", u.clerk_id).eq("status", "Enabled").eq("kind", "own").not("xero_contact_id", "is", null);
  if (!cos?.length) return { state: "needs_review", note: "This clerk's company isn't linked to a Xero contact yet (Clerk portal → Company links)" };
  const sup = (ai.supplier ?? "").toLowerCase();
  const co = cos.find((c) => sup && (sup.includes(c.company_name.toLowerCase()) || c.company_name.toLowerCase().includes(sup))) ?? cos[0];
  const xero = await xeroClient(admin);

  // already in Xero (entered by hand, or made here before)?
  const safe = number.replace(/"/g, "");
  const have = await xero<{ Invoices: { InvoiceID: string; InvoiceNumber: string; Status: string }[] }>("Invoices", { where: `Type=="ACCPAY" AND Contact.ContactID==Guid("${co.xero_contact_id}") AND InvoiceNumber=="${safe}"` });
  const dup = have.Invoices.find((i) => i.Status !== "DELETED" && i.Status !== "VOIDED");
  if (dup) return { state: "exists", note: `Already in Xero as bill ${dup.InvoiceNumber} (${dup.Status.toLowerCase()})`, bill_id: dup.InvoiceID, number: dup.InvoiceNumber };

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
  const tax = vat ? "INPUT2" : "NONE";
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
      Quantity: ok ? qty : 1, UnitAmount: ok ? rate : amount, AccountCode: ACCOUNT, TaxType: tax,
      ...(p && optionFor(p) ? { Tracking: optionFor(p) } : {}),
    });
  }
  for (const e of ai.expenses ?? []) {
    const amount = Number(e.amount_gbp ?? 0);
    if (amount > 0) lines.push({ Description: `${e.text} - ${monthLabel}`, Quantity: 1, UnitAmount: amount, AccountCode: ACCOUNT, TaxType: tax });
  }
  if (!lines.length) return { state: "needs_review", note: "No amounts could be read from the invoice lines: please enter it in Xero by hand" };

  // the lines must come to the invoice's own total
  const net = money(lines.reduce((s, l) => s + l.Quantity * l.UnitAmount, 0));
  const stated = Number(ai.net_gbp ?? (ai.gross_gbp && !vat ? ai.gross_gbp : NaN));
  if (Number.isFinite(stated) && Math.abs(net - stated) > 0.05) return { state: "needs_review", note: `The lines come to £${net}, but the invoice says £${stated} before VAT: please check and enter it in Xero by hand` };
  if (vat && Math.abs(money(net * 0.2) - Number(ai.vat_gbp)) > 0.05) return { state: "needs_review", note: `VAT on the invoice is £${ai.vat_gbp}, not 20% of £${net}: please check and enter it in Xero by hand` };

  const date = /^\d{4}-\d{2}-\d{2}$/.test(ai.invoice_date ?? "") ? ai.invoice_date! : new Date(Date.UTC(+period.slice(0, 4), +period.slice(5), 0)).toISOString().slice(0, 10);
  const res = await xero.put<{ Invoices: { InvoiceID: string; InvoiceNumber: string; HasErrors?: boolean; ValidationErrors?: { Message: string }[] }[] }>("Invoices", {
    Invoices: [{ Type: "ACCPAY", Status: "DRAFT", Contact: { ContactID: co.xero_contact_id }, InvoiceNumber: number, Date: date, LineAmountTypes: "Exclusive", LineItems: lines }],
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
  return { state: "created", note: `Draft bill ${number} for £${net}${vat ? ` + £${ai.vat_gbp} VAT` : ""} made in Xero, waiting for approval${attached}`, bill_id: bill.InvoiceID, number };
}

/** Every 15 minutes: invoices now in the diary that haven't been made into a Xero bill yet. */
export async function makePendingBills(admin: SupabaseClient) {
  const { data } = await admin.from("portal_uploads").select("id,ai_result").in("kind", ["invoice", "company_invoice"]).eq("diary_state", "written")
    .is("deleted_at", null).neq("status", "deleted").gte("received_at", FROM).order("received_at").limit(40);
  let made = 0;
  for (const r of (data ?? []).filter((x) => !(x.ai_result as Ai | null)?.xero).slice(0, 8)) {
    let o: BillOutcome;
    try { o = await makeBill(admin, r.id); }
    catch (e) { o = { state: "needs_review", note: `Couldn't make the Xero bill: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` }; }
    const { data: cur } = await admin.from("portal_uploads").select("ai_result").eq("id", r.id).single();
    await admin.from("portal_uploads").update({ ai_result: { ...((cur?.ai_result ?? {}) as object), xero: { ...o, at: new Date().toISOString() } } }).eq("id", r.id);
    if (o.state === "created") made++;
  }
  return made;
}
