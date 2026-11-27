"use client";
import { useState } from "react";

/**
 * Asking the clerk for things on their next reports (Ronan, 27 Nov 2026): type one, Add, type another, Add, then Send:
 * it goes from your own email to the clerk and each one is kept on the job, to check on their next report.
 */
export function AskClerk({ action, clerk, canEmail }: { action: (form: FormData) => void; clerk: { first: string; email: string } | null; canEmail: boolean }) {
  const [items, setItems] = useState<string[]>([]);
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (t) { setItems((xs) => [...xs, t]); setText(""); } };
  return (
    <form action={action} className="form" style={{ marginTop: 10 }}>
      <label htmlFor="ask" className="small"><b>Ask the clerk for their next reports</b> <span className="muted">(one at a time)</span></label>
      <div className="row" style={{ gap: 8 }}>
        <input id="ask" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="e.g. Start each report from last week's checked report, downloaded from the Drive" style={{ flex: 1 }} />
        <button type="button" className="btn" onClick={add} disabled={!text.trim()}>Add</button>
      </div>
      {!!items.length && (
        <ol style={{ margin: "10px 0" }}>
          {items.map((t, i) => (
            <li key={i}>{t} <button type="button" className="btn small" title="Take this one out" onClick={() => setItems((xs) => xs.filter((_, k) => k !== i))}>✕</button></li>
          ))}
        </ol>
      )}
      <input type="hidden" name="text" value={[...items, text.trim()].filter(Boolean).join("\n")} />
      {!!(items.length || text.trim()) && (
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {clerk && canEmail
            ? <button className="btn primary" name="send" value="1">Send to {clerk.first} from my email</button>
            : <span className="small neg">{!clerk ? "No email address for this clerk on the dashboard, so it can't be emailed." : "Your email isn't connected to the dashboard, so it can't send from it."}</span>}
          <button className="btn small" name="send" value="">Just save, don&apos;t email</button>
          {clerk && <span className="small muted">To {clerk.email}. Each one is kept on this job, to tick off on their next report.</span>}
        </div>
      )}
    </form>
  );
}
