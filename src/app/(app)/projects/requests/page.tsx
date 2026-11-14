import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { fd } from "@/lib/format";
import { createFromRequest, ignoreRequest } from "../actions";

export const dynamic = "force-dynamic";

// a likely project name from the subject: drop the request words, keep the place
const guessName = (subject: string) => subject
  .replace(/^(re|fw|fwd):\s*/gi, "")
  .replace(/\b(request(ed)? for|fee proposal|fee request|quotation|quote|pricing|tender|expression of interest|clerk of works|CoW|CQM|M&E|services|support|resource|lead|for|-|–|:)\b/gi, " ")
  .replace(/\s+/g, " ").trim().slice(0, 60);

/** P1: emails that look like a request to price. Nothing is created until someone says so. */
export default async function PriceRequests() {
  await requireProfile();
  const db = await createClient();
  const [{ data: reqs }, { data: clients }] = await Promise.all([
    db.from("price_requests").select("id,thread_id,from_name,from_email,subject,snippet,received_at,client_id").eq("status", "new").order("received_at", { ascending: false }),
    db.from("clients").select("id,name").order("name"),
  ]);
  return (
    <>
      <Link href="/projects" className="small">← Projects</Link>
      <div className="head"><div>
        <h1>Pricing requests</h1>
        <p>Emails from the last few days that look like someone asking us to price a job. Check the name and client, then create the enquiry, or mark it as not a request. Creating one starts the Pricing workflow and its reminders.</p>
      </div></div>
      {!(reqs ?? []).length && <p className="empty">Nothing waiting. New ones are picked up from your email every hour.</p>}
      {(reqs ?? []).map((r) => (
        <section key={r.id} className="panel" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <b>{r.subject}</b>
            <span className="small muted">{r.from_name} · {r.received_at ? fd(r.received_at.slice(0, 10)) : ""} · <a href={`https://mail.google.com/mail/u/0/#all/${r.thread_id}`} target="_blank" rel="noopener">open email ↗</a></span>
          </div>
          <p className="small muted" style={{ margin: 0 }}>{r.snippet}</p>
          <form action={createFromRequest.bind(null, r.id)} className="row" style={{ alignItems: "flex-end" }}>
            <div className="field"><label htmlFor={`n-${r.id}`}>Project name</label><input id={`n-${r.id}`} name="name" required defaultValue={guessName(r.subject ?? "")} /></div>
            <div className="field"><label htmlFor={`c-${r.id}`}>Client</label>
              <select id={`c-${r.id}`} name="client_id" defaultValue={r.client_id ?? ""}>
                <option value="">Not sure / new client</option>
                {(clients ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></div>
            <button className="btn primary">Create enquiry</button>
          </form>
          <form action={ignoreRequest.bind(null, r.id)}><button className="linklike small">Not a request to price</button></form>
        </section>
      ))}
    </>
  );
}
