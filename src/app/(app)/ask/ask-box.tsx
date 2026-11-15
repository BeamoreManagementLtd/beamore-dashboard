"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { ask } from "./actions";

type Turn = { role: "user" | "assistant"; text: string };
const EXAMPLES = ["Which jobs still need a clerk?", "What's overdue for Gleeds?", "When does Dave Finn's insurance expire?", "What's outstanding for Cannon Wharf?"];

const LINK = /(\/(?:projects|personnel|clerk-portal|invoices|due|reports|workflows|finance)(?:\/[\w-]+)?(?:\?[\w=&-]+)?)/g;
/** Bold (**text**) and dashboard paths ("/projects/abc") in the answer become bold text and links. */
function Inline({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/g).map((chunk, b) => (b % 2 ? <b key={b}>{chunk}</b> : chunk.split(LINK).map((p, i) => (i % 2
    ? <Link key={`${b}-${i}`} href={p}>{p.startsWith("/projects") ? "open project" : p.startsWith("/personnel") ? "open clerk" : "open"}</Link>
    : <span key={`${b}-${i}`}>{p}</span>))))}</>;
}
function Answer({ text }: { text: string }) {
  return <div className="ask-answer">{text.split("\n").map((line, i) => {
    const bullet = /^\s*[-*•]\s+/.test(line);
    return <div key={i} className={bullet ? "ask-li" : undefined}>{bullet ? "• " : ""}<Inline text={line.replace(/^\s*[-*•]\s+/, "").replace(/^#+\s*/, "")} /></div>;
  })}</div>;
}
export function AskBox({ compact = false }: { compact?: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setQ("");
    const history = turns;
    setTurns([...history, { role: "user", text: question }]);
    const r = await ask(history, question);
    setTurns([...history, { role: "user", text: question }, { role: "assistant", text: r.text }]);
    setBusy(false);
    input.current?.focus();
  }

  return (
    <section className={`panel ask${compact ? " compact" : ""}`}>
      <h2>Ask the dashboard</h2>
      {!turns.length && (
        <div className="ask-examples">
          {EXAMPLES.map((e) => <button key={e} className="btn" type="button" onClick={() => send(e)}>{e}</button>)}
        </div>
      )}
      {!!turns.length && (
        <div className="ask-thread">
          {turns.map((t, i) => (
            <div key={i} className={`ask-turn ${t.role}`}>{t.role === "user" ? <b>{t.text}</b> : <Answer text={t.text} />}</div>
          ))}
          {busy && <div className="ask-turn assistant muted">Looking that up…</div>}
        </div>
      )}
      <form className="ask-form" onSubmit={(e) => { e.preventDefault(); send(q); }}>
        <textarea ref={input} rows={compact ? 1 : 2} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask about any project, clerk, invoice or to-do…"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(q); } }} />
        <button className="btn primary" disabled={busy || !q.trim()}>{busy ? "…" : "Ask"}</button>
      </form>
      {!!turns.length && <button type="button" className="linklike small" onClick={() => setTurns([])}>Start again</button>}
    </section>
  );
}
