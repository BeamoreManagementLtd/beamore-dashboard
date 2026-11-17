"use client";
import { useState, useTransition } from "react";
import { readInfoFromEmail, saveInfoAnswers } from "../actions";

type Item = { id: string; item: string; value: string | null; value_from: string | null };
const OFFICE_ONLY = /\bPO\b|purchase order|invoic|fee|rate|cost|payment/i;
const FROM: Record<string, string> = { email: "from the client's email", diary: "from the clerk's diary", manual: "typed in" };

/**
 * What the client gave us for each checklist item (Ronan, 17 Nov 2026). "Read the client's emails" fills in what it can
 * find; Save shares it with the job's clerks (email, portal, Google Doc in the folder). PO / invoicing stays office-only.
 */
export function InfoAnswers({ projectId, items, clerks }: { projectId: string; items: Item[]; clerks: string[] }) {
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(items.map((i) => [i.id, i.value ?? ""])));
  const [from, setFrom] = useState<Record<string, string>>(Object.fromEntries(items.map((i) => [i.id, i.value_from ?? "manual"])));
  const [msg, setMsg] = useState("");
  const [busy, start] = useTransition();
  const changed = items.some((i) => (i.value ?? "") !== (vals[i.id] ?? ""));
  return (
    <div style={{ marginTop: 14 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <h3 style={{ margin: 0 }}>What the client gave us</h3>
        <button type="button" className="btn" disabled={busy} onClick={() => start(async () => {
          setMsg("Reading the client's emails about this job…");
          const r = await readInfoFromEmail(projectId);
          if (r.ok) { setVals((v) => ({ ...v, ...Object.fromEntries(Object.entries(r.values).filter(([id]) => !v[id]?.trim())) })); setFrom((f) => ({ ...f, ...Object.fromEntries(Object.keys(r.values).map((id) => [id, "email"])) })); }
          setMsg(r.message);
        })}>Read the client&apos;s emails</button>
      </div>
      <p className="small muted" style={{ margin: "4px 0 8px" }}>Names with email and phone, project numbers, links. Saving sends the details to {clerks.length ? clerks.join(" and ") : "the clerk once one is allocated"} (only what&apos;s new or changed), puts them on their portal and in &quot;Project information&quot; in the project folder. Items marked office only (PO, invoicing) never go to the clerk.</p>
      <div style={{ display: "grid", gap: 8 }}>
        {items.map((i) => (
          <label key={i.id} className="small" style={{ display: "grid", gap: 2 }}>
            <span><b>{i.item}</b>{OFFICE_ONLY.test(i.item) && <span className="muted"> · office only</span>}{vals[i.id]?.trim() && from[i.id] && <span className="muted"> · {FROM[from[i.id]] ?? ""}</span>}</span>
            <textarea rows={vals[i.id] && vals[i.id].length > 70 ? 3 : 1} value={vals[i.id] ?? ""} onChange={(e) => { setVals({ ...vals, [i.id]: e.target.value }); setFrom({ ...from, [i.id]: "manual" }); }} style={{ width: "100%", resize: "vertical" }} />
          </label>
        ))}
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 8 }}>
        <button type="button" className="btn primary" disabled={busy} onClick={() => start(async () => {
          const r = await saveInfoAnswers(projectId, items.map((i) => ({ id: i.id, value: vals[i.id] ?? "", from: from[i.id] ?? "manual" })));
          setMsg(r.message);
        })}>{busy ? "Working…" : changed ? "Save and send to the clerk" : "Send to the clerk"}</button>
        <span className="small muted">{msg}</span>
      </div>
    </div>
  );
}
