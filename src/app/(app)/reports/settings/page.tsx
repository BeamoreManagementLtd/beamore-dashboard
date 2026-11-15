import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { fdt } from "@/lib/format";
import { saveSettings } from "../actions";

export const dynamic = "force-dynamic";

/** The team's standard email for sending reports, the deadlines, and each person's email connection. */
export default async function ReportSettings({ searchParams }: { searchParams: Promise<{ saved?: string; email?: string; as?: string; reason?: string }> }) {
  const me = await requireProfile();
  const { saved, email, as, reason } = await searchParams;
  const db = await createClient();
  const admin = createServiceClient();
  const [{ data: s }, { data: staff }, { data: conns }] = await Promise.all([
    db.from("report_settings").select("*").eq("id", 1).single(),
    db.from("profiles").select("id,full_name,email").order("full_name"),
    admin.from("user_google").select("profile_id,email,connected_at"),
  ]);
  const mine = (conns ?? []).find((c) => c.profile_id === me.id);
  return (
    <>
      <p className="small"><Link href="/reports">Reports</Link></p>
      <div className="head"><div><h1>Standard email &amp; settings</h1><p>Used when anyone clicks &ldquo;Approve and send&rdquo;. They can still change the email for one report before sending.</p></div></div>
      {saved && <p className="callout good">Saved.</p>}
      {email === "connected" && <p className="callout good">Your email {as} is connected. Reports you approve are sent from it.</p>}
      {email === "error" && <p className="callout bad">Couldn&apos;t connect your email: {reason}</p>}

      <section className="panel">
        <h2>Your email</h2>
        {mine ? <p>Connected as <b>{mine.email}</b> since {fdt(mine.connected_at)}. <Link className="btn small" href="/api/google/connect?for=me">Connect again</Link></p>
          : <p>Not connected yet. <Link className="btn primary" href="/api/google/connect?for=me">Connect my email</Link></p>}
        <p className="small muted">Google asks you to sign in with your @beamore.co.uk account and allow the dashboard to send email for you. It can only send; it can&apos;t read your mailbox. Sent reports appear in your own Sent folder.</p>
        <table><tbody>{(staff ?? []).map((p) => { const c = (conns ?? []).find((x) => x.profile_id === p.id); return (
          <tr key={p.id}><td>{p.full_name ?? p.email}</td><td className="small">{c ? <span className="pill good">Connected ({c.email})</span> : <span className="pill muted">Not connected</span>}</td></tr>
        ); })}</tbody></table>
      </section>

      <section className="panel">
        <h2>The standard email</h2>
        <form action={saveSettings} className="form">
          <div className="field"><label htmlFor="su">Subject</label><input id="su" name="subject" defaultValue={s?.email_subject ?? ""} /></div>
          <div className="field"><label htmlFor="bo">Email</label><textarea id="bo" name="body" rows={10} defaultValue={s?.email_body ?? ""} /></div>
          <p className="small muted">These fill themselves in: <code>{"{project}"}</code> <code>{"{report_number}"}</code> <code>{"{visit_date}"}</code> <code>{"{clerk}"}</code> <code>{"{sender_name}"}</code> <code>{"{sender_first_name}"}</code></p>
          <div className="row" style={{ gap: 16 }}>
            <div className="field"><label htmlFor="cd">Clerks: working days after the visit to upload</label><input id="cd" name="clerk_days" type="number" min={0} max={10} defaultValue={s?.clerk_days ?? 1} style={{ width: 80 }} /></div>
            <div className="field"><label htmlFor="td">Team: working days after upload to send</label><input id="td" name="team_days" type="number" min={0} max={10} defaultValue={s?.team_days ?? 1} style={{ width: 80 }} /></div>
          </div>
          <button className="btn primary">Save</button>
          {s?.updated_by && <p className="small muted">Last changed by {s.updated_by}, {fdt(s.updated_at)}.</p>}
        </form>
      </section>
    </>
  );
}
