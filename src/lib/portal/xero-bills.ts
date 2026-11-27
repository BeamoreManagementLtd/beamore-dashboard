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

/** redo: a draft already made from this invoice gets its lines rebuilt in place (one line per project); approved bills are left alone */
export async function makeBill(admin: SupabaseClient, uploadId: string, opts: { redo?: boolean; dry?: boolean } = {}): Promise<BillOutcome> {
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
  const redoId = opts.redo && dup?.Status === "DRAFT" ? dup.InvoiceID : null;
  if (dup && !redoId) return { state: "exists", note: `Already in Xero as bill ${dup.InvoiceNumber} (${dup.Status.toLowerCase()})`, bill_id: dup.InvoiceID, number: dup.InvoiceNumber };

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
  type Proj = NonNullable<(typeof jobs)[number]["project"]>;
  const lineFor = (p: Proj, qty: number, rate: number): Line => ({
    Description: `${p.display_name ?? p.name} - ${monthLabel}`, Quantity: qty, UnitAmount: rate, AccountCode: account, TaxType: tax,
    ...(optionFor(p) ? { Tracking: optionFor(p) } : {}),
  });
  // ALWAYS one line per project, with the project's name, its number of visits and the day rate (Ronan, 27 Nov 2026:
  // "You just put in one line, 17 visits. That's not good enough... I want the project name, the quantity of visits,
  // and the unit price for each"). The visits per project come from the diary (this clerk's charged days that month,
  // which is where this invoice was written), else from the visits read off the invoice. A line that can't be split
  // so that it still adds up exactly waits for a person rather than going in as one lump.
  const { data: dv } = await admin.from("diary_visits").select("project_id,days").eq("clerk_id", u.clerk_id).eq("side", "charged")
    .gte("visit_date", `${period}-01`).lt("visit_date", new Date(Date.UTC(+period.slice(0, 4), +period.slice(5), 1)).toISOString().slice(0, 10)).not("project_id", "is", null);
  const diaryDays = new Map<string, number>();
  for (const v of dv ?? []) diaryDays.set(v.project_id as string, (diaryDays.get(v.project_id as string) ?? 0) + Number(v.days ?? 0));
  const invoiceDays = new Map<string, number>();
  for (const v of ai.visits ?? []) { const p = jobs.find((j) => j.wording === v.site.trim())?.project; if (p) invoiceDays.set(p.id, (invoiceDays.get(p.id) ?? 0) + (Number(v.half_days) || 2) / 2); }
  // the diary's projects too (one with no diary aliases isn't in the list above)
  const missing = [...diaryDays.keys()].filter((id) => !(projects ?? []).some((p) => p.id === id));
  const extra = missing.length ? (await admin.from("projects").select("id,name,display_name,diary_aliases,is_dfe,folder_kind").in("id", missing)).data ?? [] : [];
  const projById = (id: string) => [...(projects ?? []), ...extra].find((p) => p.id === id) ?? null;
  const onInvoice = new Set(jobs.map((j) => j.project?.id).filter(Boolean) as string[]);
  const whole = (n: number) => Math.abs(n * 2 - Math.round(n * 2)) < 0.001; // a day rate in whole pounds or 50p
  /** Days per project that add up to the amount: the quantity when known, else a day rate that comes out exactly. */
  const split = (amount: number, qty: number | null, rate: number | null, only: Set<string>) => {
    for (const src of [diaryDays, invoiceDays]) {
      const ids = [...src.keys()].filter((id) => src.get(id)! > 0 && (!only.size || only.has(id)) && projById(id));
      const total = ids.reduce((s, id) => s + src.get(id)!, 0);
      if (!ids.length || !(total > 0)) continue;
      const r = qty != null && rate != null ? (Math.abs(total - qty) < 0.01 ? rate : null) : money(amount / total);
      if (r == null || !whole(r) || r < 100 || Math.abs(money(r * total) - amount) > 0.02) continue;
      return ids.map((id) => ({ p: projById(id)! as Proj, qty: Math.round(src.get(id)! * 100) / 100, rate: r }));
    }
    return null;
  };
  // the projects this invoice can be for: those named in its visits, else (no visits read) the diary's for the month
  const candidates = onInvoice.size ? onInvoice : new Set([...diaryDays.keys()].filter((id) => projById(id)));
  const only1 = candidates.size === 1 ? projById([...candidates][0]) : null;
  const num = (x: string) => Number(x.replace(/,/g, ""));
  /** The days and rates written on a line: "17 visits @ £315", "4@£320; 1@£160", "8 x £315", "£300 x 16", "300 x 9", "5x". */
  const pairs = (text: string, amount: number): { qty: number; rate: number }[] | null => {
    const found: { qty: number; rate: number }[] = [];
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:x\s*)?(?:inspections?|visits?|days?)?\s*@\s*£?\s*([\d,]+(?:\.\d+)?)/gi)) found.push({ qty: num(m[1]), rate: num(m[2]) });
    if (!found.length) for (const m of text.matchAll(/£?\s*([\d,]+(?:\.\d+)?)\s*[x×]\s*£?\s*([\d,]+(?:\.\d+)?)/gi)) {
      const a = num(m[1]), b = num(m[2]); found.push(a > b ? { qty: b, rate: a } : { qty: a, rate: b });
    }
    if (found.length && Math.abs(found.reduce((s, f) => s + f.qty * f.rate, 0) - amount) < 0.02) return found;
    const nx = /\b(\d+(?:\.\d+)?)\s*x\b(?!\s*£?\d)/i.exec(text); // "5x (1 day)": the rate is what's left
    // not when the line also gives a rate that doesn't add up (Carl Smith's "4 x Days @ £350" for five dates and £1,750):
    // then the visits decide
    if (nx && !found.length && whole(amount / num(nx[1]))) return [{ qty: num(nx[1]), rate: money(amount / num(nx[1])) }];
    return null;
  };
  const expenseLike = (text: string, amount: number) => /hotel|mileage|travel|parking|train|fuel|accommodation|subsistence/i.test(text) || (ai.expenses ?? []).some((e) => Math.abs(Number(e.amount_gbp ?? 0) - amount) < 0.01 && !/visit|inspection|day/i.test(text));
  // each line: its project (named on the line, else the only one) and its days x rate; lines dated one per visit count
  // as one visit at that price. Then the same project at the same rate is added up into one line.
  const merged = new Map<string, { p: Proj; qty: number; rate: number }>();
  const add = (p: Proj, qty: number, rate: number) => { const k = `${p.id}|${rate}`; const m = merged.get(k); if (m) m.qty = Math.round((m.qty + qty) * 100) / 100; else merged.set(k, { p, qty, rate }); };
  const lines: Line[] = [];
  const lumps: string[] = [];
  const priced = (ai.lines ?? []).filter((l) => Number(l.amount_gbp ?? 0) > 0);
  for (const l of priced) {
    let amount = Number(l.amount_gbp);
    // the only priced line is the total with VAT (Sunny Singh's CMS 13: £8,088 on the line, £6,740 + £1,348 VAT): the net
    if (vat && priced.length === 1 && ai.gross_gbp && ai.net_gbp && Math.abs(amount - Number(ai.gross_gbp)) < 0.05) amount = Number(ai.net_gbp);
    if (expenseLike(l.text, amount)) { lines.push({ Description: `${l.text} - ${monthLabel}`, Quantity: 1, UnitAmount: amount, AccountCode: account, TaxType: tax }); continue; }
    const t = l.text.toLowerCase();
    const named = [...jobs].sort((a, b) => b.wording.length - a.wording.length).find((j) => j.project && t.includes(j.wording.toLowerCase()))
      ?? jobs.find((j) => j.project && words(j.wording).some((w) => t.includes(w)));
    // a site the invoice reading couldn't link (Mark Prickett's "Northumberland College"): the clerk's projects in the
    // diary this month, by name
    const byName = !named ? [...diaryDays.keys()].map(projById).filter(Boolean).find((x) => words(String(x!.display_name ?? x!.name).replace(/\s\d{4}$/, "")).some((w) => t.includes(w))) : null;
    // a site on the line that isn't a project on the dashboard (Paul Hankin's St John Vianney): its own line under the
    // name on the invoice (no tracking code), never folded into another job
    const unlinked = !named && !byName ? [...jobs].sort((a, b) => b.wording.length - a.wording.length).find((j) => !j.project && t.includes(j.wording.toLowerCase())) : null;
    const p = (named?.project ?? byName ?? (unlinked ? { id: `site:${unlinked.wording}`, name: unlinked.wording.replace(/\.\s/g, " "), display_name: null, diary_aliases: null, is_dfe: null, folder_kind: null } : null) ?? only1) as Proj | null;
    const dated = /\b\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?\b|\b\d{1,2}(?:st|nd|rd|th)\b/i.test(l.text);
    const ps = pairs(l.text, amount) ?? ((dated || /daily rate|day rate|visit|inspection/i.test(l.text)) && whole(amount) && amount >= 100 && amount <= 600 ? [{ qty: 1, rate: amount }] : null);
    if (p && ps) { for (const x of ps) add(p, x.qty, x.rate); continue; }
    // no project on the line (several jobs on one line), or no days: split by the visits
    const one = ps?.length === 1 ? ps[0] : null;
    const parts = split(amount, one?.qty ?? null, one?.rate ?? null, p ? new Set([p.id]) : candidates);
    if (parts) { for (const x of parts) add(x.p, x.qty, x.rate); continue; }
    lumps.push(`"${l.text}" (£${amount})`);
  }
  if (lumps.length) return { state: "needs_review", note: `Couldn't split ${lumps.join(", ")} into one line per project with the visits and day rate (the visits on the invoice and in the diary don't add up to it): please enter it in Xero by hand, one line per project` };
  lines.unshift(...[...merged.values()].map((m) => lineFor(m.p, m.qty, m.rate)));
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

  // dry: what the lines would be, nothing written
  if (opts.dry) return { state: "created", note: lines.map((l) => `${l.Description} | ${l.Quantity} x £${l.UnitAmount} | ${l.Tracking ? `code: ${l.Tracking[0].Option}` : "NO CODE"}`).join(" || "), bill_id: redoId ?? dup?.InvoiceID, number: `${number}${dup ? ` (${dup.Status})` : ""}` };
  if (redoId) {
    const up = await xero.post<{ Invoices: { HasErrors?: boolean; ValidationErrors?: { Message: string }[] }[] }>(`Invoices/${redoId}`, { Invoices: [{ InvoiceID: redoId, LineAmountTypes: "Exclusive", LineItems: lines }] });
    const b = up.Invoices?.[0];
    if (!b || b.HasErrors) return { state: "needs_review", note: `Xero didn't take the new lines: ${(b?.ValidationErrors ?? []).map((v) => v.Message).join("; ") || "no reason given"}`, bill_id: redoId, number };
    return { state: "created", note: `Draft bill ${number} for £${net}${vat ? ` + £${ai.vat_gbp} VAT` : ""} in Xero, one line per project (redone ${new Date().toISOString().slice(0, 10)}), waiting for approval`, bill_id: redoId, number };
  }
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
      await xero.attach(`Invoices/${bill.InvoiceID}`, safeName(u.file_name), Buffer.from(await g.download(u.drive_file_id)), u.mime || "application/pdf");
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
        await xero.attach(`Invoices/${x.bill_id}`, safeName(r.file_name), Buffer.from(await g.download(r.drive_file_id)), r.mime || "application/pdf");
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

/** Xero refuses attachment names with characters like ":" (Aidan Cusack's " 2026:20- Beamore Invoice...pdf"). */
export const safeName = (n: string) => n.replace(/[\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || "invoice.pdf";
