import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd, fdy, today, daysBetween, CHASE_STATUS } from "@/lib/format";
import { saveChaseState, addChaseEvent } from "../actions";

export const dynamic = "force-dynamic";

export default async function InvoiceLog({ params }: { params: Promise<{ number: string }> }) {
  await requireProfile();
  const { number } = await params;
  const num = decodeURIComponent(number);
  const db = await createClient();
  const { data: inv } = await db.from("invoices").select("id,number,reference,issued,due,amount_due,clients(name),projects(display_name)").eq("number", num).maybeSingle();
  if (!inv) notFound();
  const [{ data: cs }, { data: events }, { data: staff }] = await Promise.all([
    db.from("chase_state").select("*").eq("invoice_id", inv.id).maybeSingle(),
    db.from("chase_events").select("*").eq("invoice_id", inv.id).order("happened_at", { ascending: false }),
    db.from("profiles").select("id,full_name,email").order("full_name"),
  ]);
  const client = inv.clients as unknown as { name: string } | null;
  const project = inv.projects as unknown as { display_name: string } | null;
  const save = saveChaseState.bind(null, inv.id, inv.number);
  const add = addChaseEvent.bind(null, inv.id, inv.number);
  const overdue = inv.due ? daysBetween(inv.due, today()) : 0;

  return (
    <>
      <Link href="/invoices" className="small">← Overdue client invoices</Link>
      <div className="head">
        <div>
          <p className="mono muted">{inv.number} · invoice chase</p>
          <h1>{client?.name}</h1>
          <p>{inv.reference} · {gbp(inv.amount_due)} · due {fdy(inv.due)} · <b className="neg">{overdue} days overdue</b>{project ? ` · ${project.display_name}` : ""}</p>
        </div>
      </div>
      <div className="grid2">
        <section className="panel">
          <h2>Timeline</h2>
          {events?.length ? (
            <ol className="timeline">
              {events.map((e) => (
                <li key={e.id}>
                  <span className="when">{fd(e.happened_at)}</span>
                  <div>
                    <b>{e.kind}</b> <span className="src">{e.source}</span>
                    {e.gmail_thread_id && <> <a className="small" href={`https://mail.google.com/mail/u/0/#all/${e.gmail_thread_id}`} target="_blank" rel="noopener">open ↗</a></>}
                    <p>{e.body}</p><p className="small muted">{e.who}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="empty">No chase history yet.</p>}
        </section>
        <div style={{ display: "grid", gap: 16 }}>
          <section className="panel">
            <h2>Where it stands</h2>
            <form action={save} className="form">
              <div className="row">
                <div className="field"><label htmlFor="status">Status</label>
                  <select id="status" name="status" defaultValue={cs?.status ?? "new"}>
                    {Object.entries(CHASE_STATUS).map(([k, [, l]]) => <option key={k} value={k}>{l}</option>)}
                  </select></div>
                <div className="field"><label htmlFor="with_whom">Next move is with</label>
                  <select id="with_whom" name="with_whom" defaultValue={cs?.with_whom ?? "Beamore"}>
                    {["Beamore", "Client", "Ronan"].map((w) => <option key={w}>{w}</option>)}
                  </select></div>
              </div>
              <div className="row">
                <div className="field"><label htmlFor="owner_id">Beamore owner</label>
                  <select id="owner_id" name="owner_id" defaultValue={cs?.owner_id ?? ""}>
                    <option value="">Unassigned</option>
                    {staff?.map((s) => <option key={s.id} value={s.id}>{s.full_name ?? s.email}</option>)}
                  </select></div>
                <div className="field"><label htmlFor="next_action_due">Next action due</label>
                  <input type="date" id="next_action_due" name="next_action_due" defaultValue={cs?.next_action_due ?? ""} /></div>
              </div>
              <div className="field"><label htmlFor="next_action">Next action</label>
                <input id="next_action" name="next_action" defaultValue={cs?.next_action ?? ""} /></div>
              <div className="field"><label htmlFor="promised_date">Promised payment date</label>
                <input type="date" id="promised_date" name="promised_date" defaultValue={cs?.promised_date ?? ""} /></div>
              <button className="btn primary" type="submit">Save</button>
            </form>
          </section>
          <section className="panel">
            <h2>Log a call, email or note</h2>
            <form action={add} className="form">
              <div className="field"><label htmlFor="kind">Type</label>
                <select id="kind" name="kind"><option>Phone call</option><option>Email sent</option><option>Note</option></select></div>
              <div className="field"><label htmlFor="body">Details</label><textarea id="body" name="body" rows={3} required /></div>
              <button className="btn primary" type="submit">Add to timeline</button>
            </form>
          </section>
        </div>
      </div>
    </>
  );
}
