import { requireProfile } from "@/lib/auth";
import { AskBox } from "./ask-box";
import { createClient } from "@/lib/supabase/server";
import { DAILY_LIMIT } from "@/lib/ask";

export const metadata = { title: "Ask · Beamore" };

export default async function AskPage() {
  const me = await requireProfile();
  const db = await createClient();
  const { data: reqs } = await db.from("ai_requests").select("id,at,summary,status,answer").eq("requested_by", me.id).gte("at", new Date(Date.now() - 14 * 864e5).toISOString()).order("at", { ascending: false }).limit(10);
  return (
    <>
      <div className="head"><div><h1>Ask</h1><p>Ask anything about projects, clerks, invoices, the diary or the to-do list. It looks things up and answers, and can do work for you: add or tick off to-dos, add project notes, set clerks, mark information received. Anything outside Beamore work, or bigger changes, goes to Ronan to approve first.{me.role === "director" ? " You can also ask it to search your email." : ""}</p></div></div>
      <AskBox />
      {!!reqs?.length && (
        <section className="panel">
          <h2>Waiting for Ronan</h2>
          <p className="muted small">Things you asked for that needed Ronan&apos;s OK (anything outside Beamore work, marking jobs won or lost, email drafts{me.role === "director" ? "" : `, or more than ${DAILY_LIMIT} questions in a day`}).</p>
          {reqs.map((r) => (
            <div key={r.id} className="ask-turn assistant">
              <span className={`pill ${r.status === "approved" ? "good" : r.status === "denied" ? "bad" : "neutral"}`}>{r.status === "pending" ? "Waiting" : r.status === "approved" ? "Approved" : "Not approved"}</span> {r.summary}
              {r.answer && <div style={{ marginTop: 6 }}>{r.answer}</div>}
            </div>
          ))}
        </section>
      )}
    </>
  );
}
