"use client";
import { useActionState, useState } from "react";
import { createProject, type NewProjectResult } from "./actions";

/** "New project" by hand: a phone enquiry, or a job to set up before any cost proposal (Ronan, 16 Nov 2026). */
export function NewProjectForm({ clients, nextNumber }: { clients: { id: string; name: string }[]; nextNumber: number }) {
  const [state, action, busy] = useActionState<NewProjectResult | null, FormData>(createProject, null);
  const [client, setClient] = useState("");
  const duplicate = !!state?.message?.startsWith("There's already");
  return (
    <form action={action} className="form">
      {state?.message && <p className="callout bad">{state.message}</p>}
      <div className="row">
        <div className="field" style={{ flex: "2 1 220px" }}><label htmlFor="np-name">Project name (no number)</label>
          <input id="np-name" name="name" required placeholder="e.g. St Aidans" /></div>
        <div className="field" style={{ flex: "2 1 220px" }}><label htmlFor="np-client">Client</label>
          <select id="np-client" name="client_id" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">New client / not sure yet</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        {!client && <div className="field" style={{ flex: "2 1 220px" }}><label htmlFor="np-newclient">New client&rsquo;s name (as in Xero, if known)</label>
          <input id="np-newclient" name="new_client" placeholder="leave blank if not sure" /></div>}
        <div className="field" style={{ flex: "1 1 180px" }}><label htmlFor="np-stage">Stage</label>
          <select id="np-stage" name="stage" defaultValue="pricing">
            <option value="enquiry">Enquiry</option>
            <option value="pricing">Pricing</option>
            <option value="sent">Cost proposal sent</option>
            <option value="won_arranging">Won – arranging clerk</option>
            <option value="live">Live (on site now)</option>
          </select></div>
      </div>
      <div className="row">
        <div className="field" style={{ flex: "2 1 260px" }}><label htmlFor="np-site">Site address (optional)</label><input id="np-site" name="site" /></div>
        <div className="field" style={{ flex: "3 1 300px" }}><label htmlFor="np-note">Note for the project log (optional)</label><input id="np-note" name="note" placeholder="e.g. Phone call from Louise, wants a price by Friday" /></div>
      </div>
      {duplicate && <label className="small"><input type="checkbox" name="confirm_duplicate" /> It&rsquo;s a different job: add it anyway</label>}
      <p className="small muted">It gets the next BM number ({nextNumber}) and goes on the Cost Proposals Register within the hour. Choosing Won or Live also sets up its folders, checklist and clerk to-dos, the same as marking a job won.</p>
      <button className="btn primary" disabled={busy}>{busy ? "Adding…" : "Add project"}</button>
    </form>
  );
}
