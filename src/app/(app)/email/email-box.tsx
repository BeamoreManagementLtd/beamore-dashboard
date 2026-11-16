"use client";
import { useState, useTransition } from "react";
import { composeEmail, sendComposed, draftComposed, dismissOutbox, type Composed, type EmailKind, type EmailResult } from "./actions";

/**
 * A button that writes an email and opens it here on the dashboard (Ronan, 16 Nov 2026): read it, change anything,
 * then Send from your own Gmail, save it in Gmail Drafts, or copy it to paste elsewhere.
 */
export function EmailBox({ kind, refId, label, initial }: { kind: EmailKind; refId: string; label: string; initial?: Composed }) {
  const [email, setEmail] = useState<Composed | null>(initial ?? null);
  const [note, setNote] = useState<EmailResult | null>(null);
  const [copied, setCopied] = useState("");
  const [busy, start] = useTransition();
  const [sent, setSent] = useState(false);

  const open = () => start(async () => {
    setNote(null); setSent(false);
    const r = await composeEmail(kind, refId);
    if ("error" in r) setNote({ ok: false, message: `Couldn't write the email: ${r.error}` }); else setEmail(r);
  });
  const act = (f: (e: Composed) => Promise<EmailResult>, sending: boolean) => start(async () => {
    if (!email) return;
    const r = await f(email);
    setNote(r);
    if (r.ok && sending) setSent(true);
  });
  const copy = async (what: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 2000); } catch { setCopied("not allowed"); }
  };
  const set = (k: "to" | "cc" | "subject" | "body") => (ev: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => email && setEmail({ ...email, [k]: ev.target.value });

  if (!email) return (
    <span>
      <button className="btn" onClick={open} disabled={busy} type="button">{busy ? "Writing…" : label}</button>
      {note && <span className={`small ${note.ok ? "" : "bad-text"}`} style={{ marginLeft: 8 }}>{note.message}</span>}
    </span>
  );
  return (
    <div className="panel" style={{ marginTop: 8, display: "grid", gap: 8, maxWidth: 760 }}>
      <div className="field"><label htmlFor={`to-${kind}`}>To {copyBtn("To", email.to)}</label><input id={`to-${kind}`} value={email.to} onChange={set("to")} disabled={sent} placeholder="name@company.co.uk" /></div>
      <div className="field"><label htmlFor={`cc-${kind}`}>Cc</label><input id={`cc-${kind}`} value={email.cc ?? ""} onChange={set("cc")} disabled={sent} /></div>
      <div className="field"><label htmlFor={`su-${kind}`}>Subject {copyBtn("Subject", email.subject)}</label><input id={`su-${kind}`} value={email.subject} onChange={set("subject")} disabled={sent} /></div>
      <div className="field"><label htmlFor={`bo-${kind}`}>Email {copyBtn("Email", email.body)}</label>
        <textarea id={`bo-${kind}`} value={email.body} onChange={set("body")} disabled={sent} rows={Math.min(22, email.body.split("\n").length + 2)} style={{ fontFamily: "inherit", lineHeight: 1.45 }} /></div>
      {email.threadId && <p className="small muted" style={{ margin: 0 }}>Goes as a reply in the conversation with them.</p>}
      {!sent ? <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn primary" type="button" disabled={busy} onClick={() => act(sendComposed, true)}>{busy ? "Working…" : "Send from my Gmail"}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => act(draftComposed, false)}>Save to Gmail Drafts</button>
        <button className="btn" type="button" onClick={() => copy("Email", email.body)}>Copy the email</button>
        {email.outboxId
          ? <button className="btn" type="button" disabled={busy} onClick={() => act((e) => dismissOutbox(e.outboxId!), true)}>Not needed</button>
          : <button className="btn" type="button" onClick={() => { setEmail(null); setNote(null); }}>Close</button>}
      </div> : !email.outboxId && <div><button className="btn" type="button" onClick={() => { setEmail(null); setSent(false); }}>Close</button></div>}
      {copied && <p className="small muted" style={{ margin: 0 }}>{copied === "not allowed" ? "Your browser didn't allow copying: select the text and press Ctrl+C" : `${copied} copied`}</p>}
      {note && <p className={`callout ${note.ok ? "good" : "bad"}`} style={{ margin: 0 }}>{note.message}</p>}
    </div>
  );

  function copyBtn(what: string, text: string) {
    return <button type="button" className="linklike small" style={{ marginLeft: 6, background: "none", border: 0, padding: 0, cursor: "pointer", textDecoration: "underline", color: "var(--accent)" }} onClick={() => copy(what, text)}>copy</button>;
  }
}
