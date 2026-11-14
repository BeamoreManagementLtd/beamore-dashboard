import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd, fdy, today, daysBetween, CHASE_STATUS } from "@/lib/format";
import { saveChaseState, addChaseEvent } from "../actions";

export const dynamic = "force-dynamic";

/** How each log entry looks: dot colour (red = from the client, blue = we emailed, green = logged by the team, grey = Xero). */
function eventLook(e: { source: string; kind: string }) {
  if (e.source === "gmail") {
    if (e.kind === "Email sent") return { dot: "out", title: "Email sent", tag: "Gmail", by: "By " };
    if (e.kind === "Email received") return { dot: "in", title: "Email from client", tag: "Gmail", by: "From " };
    if (e.kind === "Email bounced") return { dot: "in", title: "Email bounced", tag: "Gmail", by: "" };
    if (e.kind === "Invoice emailed (Xero)") return { dot: "xero", title: "Invoice emailed", tag: "Xero", by: "" };
    return { dot: "xero", title: e.kind, tag: "Gmail", by: "" };
  }
  if (e.source === "team") return { dot: "team", title: e.kind, tag: "Logged", by: "By " };
  return { dot: "xero", title: e.kind === "Invoice issued" ? "Invoice sent" : e.kind, tag: "Xero", by: "" };
}

export default async function InvoiceLog({ params, searchParams }: { params: Promise<{ number: string }>; searchParams: Promise<{ show?: string }> }) {
  await requireProfile();
  const { number } = await params;
  const { show: showRaw } = await searchParams;
  const show = ["xero", "gmail", "team"].includes(showRaw ?? "") ? showRaw : undefined;
  const num = decodeURIComponent(number);
  const db = await createClient();
  const { data: inv } = await db.from("invoices").select("id,number,xero_invoice_id,reference,issued,due,amount_due,project_id,client_id,clients(name),projects(display_name)").eq("number", num).maybeSingle();
  if (!inv) notFound();
  const [{ data: cs }, { data: events }, { data: staff }, { data: contacts }] = await Promise.all([
    db.from("chase_state").select("*").eq("invoice_id", inv.id).maybeSingle(),
    db.from("chase_events").select("*").eq("invoice_id", inv.id).order("happened_at", { ascending: false }),
    db.from("profiles").select("id,full_name,email").order("full_name"),
    db.from("invoice_contacts").select("*").or(`project_id.eq.${inv.project_id ?? "00000000-0000-0000-0000-000000000000"},client_id.eq.${inv.client_id ?? "00000000-0000-0000-0000-000000000000"}`),
  ]);
  // the project's own row wins over the client-wide ("General") one
  const contact = (contacts ?? []).find((c) => c.project_id && c.project_id === inv.project_id) ?? (contacts ?? [])[0] ?? null;
  const days = inv.due ? daysBetween(inv.due, today()) : 0;
  const mailto = contact ? `mailto:${contact.to_emails.join(",")}?${new URLSearchParams({
    ...(contact.cc_emails.length ? { cc: contact.cc_emails.join(",") } : {}),
    subject: `Overdue invoice ${inv.number} – ${inv.reference ?? ""}`,
    body: `Hello,\n\nOur invoice ${inv.number} (${inv.reference ?? ""}) for ${gbp(inv.amount_due)} was due on ${fdy(inv.due)} and is now ${days} days overdue.${contact.notes ? `\n${contact.notes}` : ""}\n\nCould you let us know when it will be paid, or if anything is holding it up?\n\nKind regards,\nBeamore Management`,
  }).toString().replace(/\+/g, "%20")}` : "";
  const client = inv.clients as unknown as { name: string } | null;
  const project = inv.projects as unknown as { display_name: string } | null;
  const save = saveChaseState.bind(null, inv.id, inv.number);
  const add = addChaseEvent.bind(null, inv.id, inv.number);
  const overdue = inv.due ? daysBetween(inv.due, today()) : 0;

  // ---- the log, filtered by source (?show=xero|gmail|team)
  type Ev = { id: string; happened_at: string; source: string; kind: string; who: string | null; body: string | null; gmail_thread_id: string | null };
  const all = (events ?? []) as Ev[];
  const shown = show ? all.filter((e) => e.source === show) : all;
  const gmailThread = all.find((e) => e.gmail_thread_id)?.gmail_thread_id ?? null;

  // ---- "ball is in our court": who has the next move, from the status and the latest emails
  const latest = (kinds: string[]) => all.find((e) => kinds.includes(e.kind));
  const lastIn = latest(["Email received", "Email bounced"]);
  const lastOut = all.find((e) => e.kind === "Email sent" || (e.source === "team" && e.kind !== "Note"));
  const t = today();
  const banner =
    cs?.status === "our_move" && lastIn?.kind === "Email bounced"
      ? { tone: "bad", title: "Ball is in our court.", text: `Our email bounced on ${fd(lastIn.happened_at)}: resend it to the right person.` }
    : cs?.status === "our_move"
      ? { tone: "bad", title: "Ball is in our court.", text: lastIn ? `${lastIn.who ?? "The client"} emailed on ${fd(lastIn.happened_at)} and nobody has replied yet.` : "We owe the client a reply." }
    : cs?.status === "queried"
      ? { tone: "warn", title: "Queried.", text: cs.next_action ? `Next: ${cs.next_action}` : "The client has queried this invoice." }
    : cs?.status === "promised" && cs.promised_date
      ? cs.promised_date < t
        ? { tone: "bad", title: "Promise missed.", text: `Payment was promised for ${fd(cs.promised_date)} and hasn't arrived.` }
        : { tone: "good", title: "Payment promised", text: `for ${fd(cs.promised_date)}.` }
    : cs?.status === "waiting"
      ? { tone: "info", title: "Waiting on them.", text: lastOut ? `Last chased ${fd(lastOut.happened_at)}${cs.next_action_due ? `; next chase ${fd(cs.next_action_due)}` : ""}.` : "Waiting for the client." }
    : overdue > 0
      ? { tone: "bad", title: "Not chased yet.", text: `${overdue} days overdue and nothing logged.` }
      : null;

  return (
    <>
      <Link href="/invoices" className="small">← Overdue invoices</Link>
      <div className="rec-head">
        <div>
          <p className="mono muted">{inv.number}</p>
          <h1 style={{ fontSize: 26 }}>{client?.name}</h1>
          <p className="muted">{inv.reference}{project ? <> · <Link href={`/projects/${inv.project_id}`}>{project.display_name}</Link></> : ""}{contact ? ` · Contact: ${contact.to_emails[0]}` : ""}</p>
        </div>
        <div className="facts">
          <div><span className="k">Amount</span><span className="v">{gbp(inv.amount_due)}</span></div>
          <div><span className="k">Due</span><span className="v">{fd(inv.due)}</span></div>
          <div><span className="k">Overdue</span><span className={`v ${overdue > 0 ? "neg" : ""}`}>{overdue > 0 ? `${overdue} days` : "Not yet"}</span></div>
          <div><span className="k">Status</span><span><span className={`pill ${CHASE_STATUS[cs?.status ?? "new"][0]}`}>{CHASE_STATUS[cs?.status ?? "new"][1]}</span></span></div>
        </div>
      </div>
      {banner && <p className={`callout ${banner.tone}`}><b>{banner.title}</b> {banner.text}</p>}
      <div className="grid2">
        <section className="panel">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h2>Chase log</h2>
            <div className="row" style={{ gap: 6 }}>
              {([["xero", "Xero"], ["gmail", "Gmail"], ["team", "Logged by team"]] as const).map(([k, l]) => (
                <Link key={k} href={show === k ? "?" : `?show=${k}`} className={`src ${show === k ? "on" : ""}`}>{l}</Link>
              ))}
            </div>
          </div>
          {shown.length ? (
            <ol className="timeline">
              {shown.map((e) => {
                const look = eventLook(e);
                return (
                  <li key={e.id}>
                    <span className="when">{fd(e.happened_at)}</span>
                    <span className={`dot ${look.dot}`} />
                    <div>
                      <div className="ev-top"><b>{look.title}</b><span className="src">{look.tag}</span>
                        {e.gmail_thread_id && <a className="small" href={`https://mail.google.com/mail/u/0/#all/${e.gmail_thread_id}`} target="_blank" rel="noopener">open ↗</a>}</div>
                      {e.body && <p>{e.body}</p>}
                      {e.who && <p className="ev-who">{look.by}{e.who}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="empty">{show ? "Nothing from this source yet." : "No chase history yet."}</p>}
        </section>
        <div style={{ display: "grid", gap: 16 }}>
          <section className="panel">
            <h2>Where we are</h2>
            <form action={save} className="form">
              <div className="field"><label htmlFor="status">Status</label>
                <select id="status" name="status" defaultValue={cs?.status ?? "new"}>
                  {Object.entries(CHASE_STATUS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}
                </select></div>
              <div className="field"><label htmlFor="owner_id">Chased by</label>
                <select id="owner_id" name="owner_id" defaultValue={cs?.owner_id ?? ""}>
                  <option value="">Unassigned</option>
                  {staff?.map((s) => <option key={s.id} value={s.id}>{s.full_name ?? s.email}</option>)}
                </select></div>
              <div className="field"><label htmlFor="promised_date">Promised date</label>
                <input type="date" id="promised_date" name="promised_date" defaultValue={cs?.promised_date ?? ""} /></div>
              <div className="field"><label htmlFor="next_action">Next action</label>
                <input id="next_action" name="next_action" defaultValue={cs?.next_action ?? ""} placeholder="e.g. Reply to Dave with a breakdown of the hours" /></div>
              <div className="field"><label htmlFor="next_action_due">Next action due</label>
                <input type="date" id="next_action_due" name="next_action_due" defaultValue={cs?.next_action_due ?? ""} /></div>
              <input type="hidden" name="with_whom" value={cs?.with_whom ?? ""} />
              <div><button className="btn primary" type="submit">Save</button></div>
            </form>
          </section>
          <section className="panel">
            <h2>Add to the log</h2>
            <form action={add} className="form">
              <div className="field"><label htmlFor="kind">What happened</label>
                <select id="kind" name="kind"><option>Phone call</option><option>Email sent</option><option>Note</option></select></div>
              <div className="field"><label htmlFor="body">Details</label><textarea id="body" name="body" rows={3} required placeholder="e.g. Spoke to Dave, payment going out Friday" /></div>
              <div><button className="btn primary" type="submit">Add to log</button></div>
              <p className="small muted">Emails in your Gmail that mention {inv.number} appear here automatically. Calls and notes are added by hand.</p>
            </form>
          </section>
          <div className="btn-row">
            {inv.xero_invoice_id
              ? <a className="btn" href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${inv.xero_invoice_id}`} target="_blank" rel="noopener">Open in Xero</a>
              : <span className="btn" aria-disabled="true" style={{ opacity: 0.45 }}>Open in Xero</span>}
            {gmailThread
              ? <a className="btn" href={`https://mail.google.com/mail/u/0/#all/${gmailThread}`} target="_blank" rel="noopener">Open Gmail thread</a>
              : <span className="btn" aria-disabled="true" style={{ opacity: 0.45 }}>Open Gmail thread</span>}
          </div>
          <section className="panel">
            <h2>Chase contacts</h2>
            {!contact ? (
              <p className="empty">No row for this project or client on the diary’s “Invoice emails” tab yet. Add one there and it appears here within the hour.</p>
            ) : (
              <>
                <p className="small"><b>To:</b> {contact.to_emails.join("; ")}</p>
                {!!contact.cc_emails.length && <p className="small"><b>CC:</b> {contact.cc_emails.join("; ")}</p>}
                {contact.notes && <p className="small muted">{contact.notes}</p>}
                <p className="small muted">From the diary’s Invoice emails tab: “{contact.label}”{contact.project_id ? "" : " (client-wide)"}.</p>
                <a className="btn primary" href={mailto}>Email chaser</a>{" "}
                <span className="small muted">Opens a pre-filled email. Log it above once sent.</span>
              </>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
