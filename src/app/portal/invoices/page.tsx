import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { myUploads, fmtDate, gbp, clerkStatus } from "@/lib/portal/data";
import { xeroClient } from "@/lib/xero";
import { UploadBox } from "../upload-box";

type Bill = { InvoiceNumber?: string; DateString?: string; Total?: number; AmountDue?: number; AmountPaid?: number; Status: string; FullyPaidOnDate?: string; Payments?: { Date: string }[] };

/** Bills from the clerk's own company (or themselves) in Xero: read only, only for their verified company links. */
async function xeroHistory(contactIds: string[]) {
  if (!contactIds.length) return null;
  try {
    const get = await xeroClient(createServiceClient());
    const where = `Type=="ACCPAY"&&(${contactIds.map((id) => `Contact.ContactID==Guid("${id}")`).join("||")})&&(Status=="AUTHORISED"||Status=="PAID")`;
    const r = await get<{ Invoices: Bill[] }>("Invoices", { where, order: "Date DESC", page: 1, pageSize: 24 });
    return r.Invoices;
  } catch {
    return "unavailable" as const;
  }
}

export default async function PortalInvoices() {
  const me = await requirePortalUser();
  if (!me.clerk) return <p className="muted">Clerks only.</p>;
  const db = createServiceClient();
  const [uploads, { data: checks }, { data: cos }] = await Promise.all([
    myUploads(db, me.clerk.id, ["invoice"]),
    db.from("portal_invoice_checks").select("upload_id,invoice_number,gross_pence,period,portal_uploads!inner(clerk_id)").eq("portal_uploads.clerk_id", me.clerk.id),
    db.from("clerk_companies").select("company_name,xero_contact_id,status,relationship").eq("clerk_id", me.clerk.id).eq("status", "Enabled"),
  ]);
  const chk = new Map((checks ?? []).map((c) => [c.upload_id, c]));
  const contacts = (cos ?? []).filter((c) => c.xero_contact_id && c.relationship !== "External company").map((c) => c.xero_contact_id as string);
  const history = await xeroHistory(contacts);

  return (
    <>
      <section className="portal-hello">
        <h1>Invoices</h1>
        <p className="muted">Upload your invoice for each month you work. We match it to the diary and pay it from Xero.</p>
      </section>
      {me.clerk.invoice_upload ? (
        <UploadBox kind="invoice" title="Upload your invoice" hint="PDF or a photo. Drop it here or choose it from your files. It's saved straight away." button="Choose invoice" />
      ) : (
        <section className="callout warn">Invoice upload isn&apos;t switched on for your account. Please email your invoice to Beamore as usual.</section>
      )}

      <section className="card">
        <h2>Invoices you&apos;ve sent</h2>
        {uploads.length ? (
          <table className="ptable">
            <thead><tr><th>Received</th><th>Month</th><th>Invoice</th><th className="num">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {uploads.map((u) => {
                const c = chk.get(u.id), s = clerkStatus(u);
                return (
                  <tr key={u.id}>
                    <td>{fmtDate(u.received_at)}</td>
                    <td>{(c?.period ?? u.period) ? new Date(`${c?.period ?? u.period}-15`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "—"}</td>
                    <td className="clip">{c?.invoice_number ?? u.file_name ?? "—"}</td>
                    <td className="num">{c?.gross_pence ? gbp(c.gross_pence) : "—"}</td>
                    <td><span className={`pill ${s.tone}`}>{s.text}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">You haven&apos;t uploaded any invoices here yet.</p>}
      </section>

      <section className="card">
        <h2>Payments from Beamore</h2>
        {history === null ? (
          <p className="muted">Your payment history appears here once Beamore has linked your company in Xero.</p>
        ) : history === "unavailable" ? (
          <p className="muted">Payment history can&apos;t be loaded right now. Please try again later.</p>
        ) : history.length ? (
          <table className="ptable">
            <thead><tr><th>Invoice</th><th>Date</th><th className="num">Total</th><th>Paid</th></tr></thead>
            <tbody>
              {history.map((b, i) => (
                <tr key={i}>
                  <td>{b.InvoiceNumber || "—"}</td>
                  <td>{fmtDate(b.DateString)}</td>
                  <td className="num">{gbp(Math.round((b.Total ?? 0) * 100))}</td>
                  <td>{b.Status === "PAID" ? <span className="pill good">Paid {fmtDate(b.FullyPaidOnDate ?? b.Payments?.at(-1)?.Date?.slice(0, 10))}</span> : <span className="pill neutral">Due {gbp(Math.round((b.AmountDue ?? 0) * 100))}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No invoices from you in Xero yet.</p>}
      </section>
    </>
  );
}
