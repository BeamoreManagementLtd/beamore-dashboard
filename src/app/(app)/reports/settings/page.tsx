import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { fdt } from "@/lib/format";
import { saveSettings } from "../actions";
import { mailboxConnection, AI_MAILBOX, signatureFor } from "@/lib/google-user";

export const dynamic = "force-dynamic";

/** The team's standard email for sending reports, the deadlines, and each person's email connection. */
export default async function ReportSettings({ searchParams }: { searchParams: Promise<{ saved?: string; email?: string; as?: string; reason?: string; ai?: string }> }) {
  const me = await requireProfile();
  const { saved, email, as, reason, ai } = await searchParams;
  const db = await createClient();
  const admin = createServiceClient();
  const [{ data: s }, { data: staff }, { data: conns }] = await Promise.all([
    db.from("report_settings").select("*").eq("id", 1).single(),
    db.from("profiles").select("id,full_name,email").order("full_name"),
    admin.from("user_google").select("profile_id,email,connected_at"),
  ]);
  const mine = (conns ?? []).find((c) => c.profile_id === me.id);
  const aiBox = me.role === "director" ? await mailboxConnection(admin, AI_MAILBOX) : null;
  // each connected person's Gmail signature, which goes under the reports they send (Ronan, 18 Nov 2026)
  const sigs = new Map(await Promise.all((conns ?? []).map(async (c) => [c.profile_id, (await signatureFor(admin, c.profile_id)).html] as const)));
  const mySig = mine ? sigs.get(me.id) ?? null : null;
  return (
    <>
      <p className="small"><Link href="/reports">Reports</Link></p>
      <div className="head"><div><h1>Standard email &amp; settings</h1><p>Used when anyone clicks &ldquo;Approve and send&rdquo;. They can still change the email for one report before sending.</p></div></div>
      {saved && <p className="callout good">Saved.</p>}
      {email === "connected" && <p className="callout good">Your email {as} is connected. Reports you approve are sent from it.</p>}
      {email === "error" && <p className="callout bad">Couldn&apos;t connect your email: {reason}</p>}
      {ai === "connected" && <p className="callout good">ai@beamore.co.uk is connected. AI feedback emails go from it.</p>}
      {ai === "error" && <p className="callout bad">Couldn&apos;t connect ai@beamore.co.uk: {reason}</p>}

      <section className="panel">
        <h2>Your email</h2>
        {mine ? <p>Connected as <b>{mine.email}</b> since {fdt(mine.connected_at)}. <Link className="btn small" href="/api/google/connect?for=me">Connect again</Link></p>
          : <p>Not connected yet. <Link className="btn primary" href="/api/google/connect?for=me">Connect my email</Link></p>}
        <p className="small muted">Google asks you to sign in with your @beamore.co.uk account and allow the dashboard to send email for you and see your Gmail settings, so your own signature goes under the reports you send. It can&apos;t read your mailbox. Sent reports appear in your own Sent folder.</p>
        {mine && (mySig
          ? <><p className="small"><b>Your signature</b>, as it will appear under the reports you send (it replaces the typed name under &ldquo;Kind regards,&rdquo;). To change it, change your signature in Gmail.</p>
              <div className="panel" style={{ background: "#fff", color: "#222" }} dangerouslySetInnerHTML={{ __html: mySig }} /></>
          : <p className="callout info small">No signature yet. If you have one in Gmail, click <b>Connect again</b> above and allow the extra permission, so it goes under the reports you send. Until then the email ends with your typed name.</p>)}
        <table><tbody>{(staff ?? []).map((p) => { const c = (conns ?? []).find((x) => x.profile_id === p.id); return (
          <tr key={p.id}><td>{p.full_name ?? p.email}</td><td className="small">{c ? <span className="pill good">Connected ({c.email})</span> : <span className="pill muted">Not connected</span>}</td><td className="small">{c ? (sigs.get(p.id) ? <span className="pill good">Signature added</span> : <span className="pill muted">No signature: connect again</span>) : null}</td></tr>
        ); })}</tbody></table>
      </section>

      {me.role === "director" && (
        <section className="panel">
          <h2>AI feedback emails (ai@beamore.co.uk)</h2>
          <p className="small">Clerks who switch on AI feedback in the portal get a short email when a report&apos;s feedback is ready. It comes from the ai@beamore.co.uk mailbox itself.</p>
          {aiBox ? <p>Connected since {fdt(aiBox.connected_at)}. <Link className="btn small" href="/api/google/connect?for=ai">Connect again</Link></p>
            : <p>Not connected yet. <Link className="btn primary" href="/api/google/connect?for=ai">Connect ai@beamore.co.uk</Link></p>}
          <p className="small muted">Google asks you to sign in as ai@beamore.co.uk (choose that account, or &ldquo;Use another account&rdquo;) and allow the dashboard to send email for it. It can only send; it can&apos;t read the mailbox. The emails appear in that account&apos;s Sent folder and replies go there.</p>
        </section>
      )}

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
