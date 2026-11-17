"use client";
import { useState, useTransition } from "react";
import { setProjectClient } from "../actions";

/** The project's client: shown under the name, with Change / Add client to pick one or add a new one (Ronan, 17 Nov 2026). */
export function ClientPicker({ projectId, current, clients }: { projectId: string; current: { id: string; name: string } | null; clients: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(!current);
  const [pick, setPick] = useState(current?.id ?? "");
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, start] = useTransition();
  if (!open) return <>{current?.name} <button type="button" className="linklike small" onClick={() => setOpen(true)}>Change client</button></>;
  return (
    <span className="row" style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      {!current && <b style={{ color: "var(--bad)" }}>No client yet:</b>}
      <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Client">
        <option value="">New client…</option>
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {!pick && <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="New client's name (as in Xero)" style={{ minWidth: 220 }} />}
      <button type="button" className="btn primary" disabled={busy || (!pick && !typed.trim()) || pick === current?.id}
        onClick={() => start(async () => { const r = await setProjectClient(projectId, pick || null, typed); setMsg(r.message); if (r.ok) setOpen(false); })}>{busy ? "Saving…" : "Save client"}</button>
      {current && <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>}
      {msg && <span className="small muted">{msg}</span>}
    </span>
  );
}
