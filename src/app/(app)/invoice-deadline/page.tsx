import { requireDirector } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { deadlines, monthName } from "@/lib/invoice-deadline";
import { setDeadline } from "./actions";

export const dynamic = "force-dynamic";

/** Clerks' invoice deadline for each month (Ronan, 26 Nov 2026). The emails go from ai@beamore.co.uk. */
export default async function InvoiceDeadline({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await requireDirector();
  const sp = await searchParams;
  const admin = createServiceClient();
  const list = (await deadlines(admin)).reverse();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : today.slice(0, 7);
  const show = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const { data: sent } = await admin.from("portal_audit").select("detail").eq("action", "invoice-deadline-email").gte("at", new Date(Date.now() - 60 * 864e5).toISOString());
  const count = (m: string, stage: string) => (sent ?? []).filter((s) => (s.detail as { month: string; stage: string }).month === m && (s.detail as { stage: string }).stage === stage).length;

  return (
    <>
      <div className="head">
        <div><h1>Clerks’ invoice deadline</h1><p>Set when each month’s invoices are due. A week before, every clerk in the diary that month who hasn’t uploaded an invoice gets an email from ai@beamore.co.uk; a reminder the day before; and a “now late” email once the time has passed.</p></div>
      </div>
      {sp.saved && <p className="callout info">Saved: {monthName(sp.saved)} invoices. The emails will go out on schedule.</p>}
      {sp.error && <p className="callout bad">Please give a month, a date and a time.</p>}
      <section className="panel">
        <h2>Set a deadline</h2>
        <form action={setDeadline} className="row">
          <label>Invoices for <input type="month" name="month" defaultValue={month} required /></label>
          <label>Due by <input type="date" name="date" required /></label>
          <label>at <input type="time" name="time" defaultValue="17:00" required /></label>
          <button className="btn primary" type="submit">Save</button>
        </form>
      </section>
      <section className="panel">
        <h2>Deadlines set</h2>
        {!list.length ? <p className="empty">None yet.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Invoices for</th><th>Due by</th><th className="num">Week-before emails</th><th className="num">Reminders</th><th className="num">Late emails</th></tr></thead>
            <tbody>{list.map((d) => (
              <tr key={d.month}><td><b>{monthName(d.month)}</b></td><td>{show(d.dueAt)}</td><td className="num">{count(d.month, "notice")}</td><td className="num">{count(d.month, "reminder")}</td><td className="num">{count(d.month, "late")}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}
