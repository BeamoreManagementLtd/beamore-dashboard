import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { xeroClient, type XeroGet } from "@/lib/xero";
import { siteKey } from "@/lib/site-key.mjs";

type XInvoice = {
  InvoiceID: string; InvoiceNumber: string; Reference?: string; Status: string; Type: string;
  Contact: { ContactID: string; Name: string };
  DateString?: string; DueDateString?: string; FullyPaidOnDate?: string;
  Total: number; AmountDue: number;
};
type ReportRow = { RowType: string; Title?: string; Cells?: { Value: string }[]; Rows?: ReportRow[] };
type Report = { Reports: { Rows: ReportRow[] }[] };

const day = (s?: string) => (s ? s.slice(0, 10) : null);
const xeroDate = (s?: string) => { // "/Date(1693440000000+0000)/"
  const m = s && /\/Date\((\d+)/.exec(s);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : day(s);
};
const londonToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });

async function allPages<T>(get: XeroGet, path: string, key: string, params: Record<string, string | number>) {
  const out: T[] = [];
  for (let page = 1; page < 50; page++) {
    const r = await get<Record<string, T[]>>(path, { ...params, page, pageSize: 500 });
    out.push(...r[key]);
    if (r[key].length < 500) break;
  }
  return out;
}

/** Label → first number in that row, for every row in a Xero report (sections flattened). */
function reportValues(rep: Report) {
  const vals: { label: string; value: number; section: string }[] = [];
  const walk = (rows: ReportRow[], section: string) => {
    for (const r of rows) {
      if (r.Rows) walk(r.Rows, r.Title ?? section);
      const label = r.Cells?.[0]?.Value;
      const num = r.Cells?.slice(1).map((c) => parseFloat(c.Value)).find((n) => !Number.isNaN(n));
      if (label && num !== undefined) vals.push({ label, value: num, section });
    }
  };
  walk(rep.Reports[0].Rows, "");
  return vals;
}

async function profitAndLoss(get: XeroGet, from: string, to: string) {
  const v = reportValues(await get<Report>("Reports/ProfitAndLoss", { fromDate: from, toDate: to }));
  const find = (re: RegExp) => v.find((x) => re.test(x.label))?.value ?? 0;
  const sales = find(/^Total (Trading )?Income$/i);
  const costTotal = find(/^Total Cost of Sales$/i);
  // Beamore books clerks to "Subcontractors" under Operating Expenses, not Cost of Sales: count it wherever it sits,
  // and only take it off cost of sales if it was inside that section.
  const subRows = v.filter((x) => /^subcontract/i.test(x.label));
  const subs = subRows.reduce((s, x) => s + x.value, 0);
  const subsInCos = subRows.filter((x) => /cost of sales/i.test(x.section)).reduce((s, x) => s + x.value, 0);
  return { sales, subcontractors: subs, cogs: costTotal - subsInCos, net_profit: find(/^Net Profit$/i) };
}

export async function syncXero(admin: SupabaseClient) {
  const started = new Date().toISOString();
  const { data: run } = await admin.from("sync_runs").insert({ source: "xero", started_at: started }).select("id").single();
  const finish = (ok: boolean, message: string) =>
    admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const get = await xeroClient(admin);
    const today = londonToday();

    // ---- outstanding sales invoices
    const open = await allPages<XInvoice>(get, "Invoices", "Invoices", {
      where: 'Type=="ACCREC"', Statuses: "AUTHORISED", summaryOnly: "true",
    });

    // ---- invoices we still show as owed that Xero no longer lists as outstanding (paid, voided, deleted)
    const { data: known } = await admin.from("invoices").select("id,number,amount_due,project_id");
    const knownBy = new Map((known ?? []).map((i) => [i.number, i]));
    const openNums = new Set(open.map((i) => i.InvoiceNumber));
    const gone = (known ?? []).filter((i) => Number(i.amount_due) > 0 && !openNums.has(i.number)).map((i) => i.number);
    const closed: XInvoice[] = [];
    for (let i = 0; i < gone.length; i += 40)
      closed.push(...(await get<{ Invoices: XInvoice[] }>("Invoices", { InvoiceNumbers: gone.slice(i, i + 40).join(","), summaryOnly: "true" })).Invoices);

    // ---- clients (Xero contact names are the standard)
    const { data: clients } = await admin.from("clients").select("id,name,xero_contact_id");
    const byContact = new Map((clients ?? []).filter((c) => c.xero_contact_id).map((c) => [c.xero_contact_id, c.id]));
    const byName = new Map((clients ?? []).map((c) => [c.name, c]));
    for (const inv of [...open, ...closed]) {
      const { ContactID, Name } = inv.Contact;
      if (byContact.has(ContactID)) continue;
      const same = byName.get(Name);
      if (same && !same.xero_contact_id) {
        await admin.from("clients").update({ xero_contact_id: ContactID }).eq("id", same.id);
        byContact.set(ContactID, same.id);
      } else if (!same) {
        const { data: c } = await admin.from("clients").insert({ name: Name, xero_contact_id: ContactID }).select("id").single();
        if (c) { byContact.set(ContactID, c.id); byName.set(Name, { id: c.id, name: Name, xero_contact_id: ContactID }); }
      } else byContact.set(ContactID, same.id);
    }

    // ---- match invoices to projects by reference ("Foxwood - August 2026") against names and diary spellings
    const { data: projects } = await admin.from("projects").select("id,name,diary_aliases");
    const projByKey = new Map<string, string>();
    for (const p of projects ?? []) for (const a of [p.name, ...p.diary_aliases]) if (siteKey(a)) projByKey.set(siteKey(a), p.id);
    const projectFor = (ref?: string) => {
      if (!ref) return null;
      const head = ref.split(/\s+[-–]\s+/)[0];
      return projByKey.get(siteKey(head)) ?? projByKey.get(siteKey(ref)) ?? null;
    };

    const rows = [...open, ...closed].map((i) => ({
      inv: i,
      row: {
        xero_invoice_id: i.InvoiceID, number: i.InvoiceNumber, client_id: byContact.get(i.Contact.ContactID) ?? null,
        reference: i.Reference ?? null, issued: day(i.DateString), due: day(i.DueDateString), total: i.Total,
        amount_due: i.Status === "AUTHORISED" ? i.AmountDue : 0, status: i.Status, synced_at: new Date().toISOString(),
      },
      project: knownBy.get(i.InvoiceNumber)?.project_id ?? projectFor(i.Reference),
    }));
    const withProject = rows.filter((r) => r.project).map((r) => ({ ...r.row, project_id: r.project }));
    const without = rows.filter((r) => !r.project).map((r) => r.row);
    for (const batch of [withProject, without])
      for (let i = 0; i < batch.length; i += 200) {
        const { error } = await admin.from("invoices").upsert(batch.slice(i, i + 200), { onConflict: "number" });
        if (error) throw new Error(`invoices: ${error.message}`);
      }

    // ---- chase history: new invoices and payments appear in each invoice's log
    const { data: ids } = await admin.from("invoices").select("id,number").in("number", rows.map((r) => r.row.number));
    const idBy = new Map((ids ?? []).map((i) => [i.number, i.id]));
    const events = [
      ...open.filter((i) => !knownBy.has(i.InvoiceNumber)).map((i) => ({
        invoice_id: idBy.get(i.InvoiceNumber), happened_at: day(i.DateString) ?? today, source: "xero", kind: "Invoice issued", who: "Xero", body: i.Reference ?? null,
      })),
      ...closed.map((i) => ({
        invoice_id: idBy.get(i.InvoiceNumber), happened_at: xeroDate(i.FullyPaidOnDate) ?? today, source: "xero",
        kind: i.Status === "PAID" ? "Paid in full" : `Marked ${i.Status.toLowerCase()} in Xero`, who: "Xero", body: null,
      })),
    ].filter((e) => e.invoice_id);
    if (events.length) await admin.from("chase_events").insert(events);

    // ---- references that match no project: listed on the Projects page for someone to link
    const unmatched = new Map<string, { reference: string; last_invoice: string; client: string; invoices: number }>();
    for (const r of rows) {
      if (r.project || !r.inv.Reference) continue;
      const head = r.inv.Reference.split(/\s+[-–]\s+/)[0];
      const k = siteKey(head);
      if (!k) continue;
      const u = unmatched.get(k) ?? { reference: head, last_invoice: r.inv.InvoiceNumber, client: r.inv.Contact.Name, invoices: 0 };
      u.invoices++; unmatched.set(k, u);
    }
    await admin.from("unmatched_invoice_refs").delete().neq("reference_key", "");
    if (unmatched.size)
      await admin.from("unmatched_invoice_refs").insert([...unmatched].map(([reference_key, u]) => ({ reference_key, ...u, last_seen: today })));

    // ---- finance (director-only table)
    // BankSummary rows are [account, opening, received, spent, closing]. Cash at bank = closing balances of the bank
    // accounts, leaving out charge/credit cards (as Xero's own cash figure does).
    const bankRep = await get<Report>("Reports/BankSummary", { fromDate: today, toDate: today });
    const accounts = (rows: ReportRow[]): { name: string; closing: number }[] => rows.flatMap((r) =>
      r.Rows ? accounts(r.Rows) : r.RowType === "Row" && r.Cells ? [{ name: r.Cells[0].Value, closing: parseFloat(r.Cells.at(-1)!.Value) }] : []);
    const cashClosing = accounts(bankRep.Reports[0].Rows)
      .filter((a) => !Number.isNaN(a.closing) && !/card|amex|credit/i.test(a.name))
      .reduce((s, a) => s + a.closing, 0);

    const owed = open.reduce((s, i) => s + i.AmountDue, 0);
    const overdue = open.filter((i) => day(i.DueDateString)! < today).reduce((s, i) => s + i.AmountDue, 0);

    const [y, m] = today.split("-").map(Number);
    const lastMonthStart = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    const lastMonthEnd = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    const fyEnd = m === 12 ? y + 1 : y; // financial year runs 1 December to 30 November
    const [month, fytd] = await Promise.all([
      profitAndLoss(get, lastMonthStart, lastMonthEnd),
      profitAndLoss(get, `${fyEnd - 1}-12-01`, today),
    ]);
    const monthLabel = lastMonthStart.slice(0, 7), fyLabel = `FY${fyEnd}-YTD`;
    await admin.from("finance_snapshots").delete().in("period", ["latest", monthLabel, fyLabel]);
    const { error: fe } = await admin.from("finance_snapshots").insert([
      { period: "latest", cash: cashClosing, receivables: owed, receivables_overdue: overdue, ...month },
      { period: monthLabel, ...month },
      { period: fyLabel, ...fytd },
    ]);
    if (fe) throw new Error(`finance: ${fe.message}`);

    const msg = `${open.length} outstanding invoices, ${closed.length} closed since last sync, ${unmatched.size} references with no project`;
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finish(false, msg);
    return { ok: false, message: msg };
  }
}
