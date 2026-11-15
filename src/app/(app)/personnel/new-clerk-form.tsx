"use client";
import { useActionState, useState } from "react";
import Link from "next/link";
import { addAndOnboardClerk, type NewClerkResult } from "./new-clerk";

type P = { id: string; display_name: string };

/** "Add new clerk": name, personal email, the @beamore.co.uk address to create, and the job they're going on. */
export function NewClerkForm({ projects, director, defaultName, defaultProject, defaultRole }: { projects: P[]; director: boolean; defaultName?: string; defaultProject?: string; defaultRole?: string }) {
  const [state, action, busy] = useActionState<NewClerkResult | null, FormData>(addAndOnboardClerk, null);
  const [name, setName] = useState(defaultName ?? "");
  const [beamore, setBeamore] = useState("");
  const [touched, setTouched] = useState(false);
  const suggested = name.trim().toLowerCase().replace(/[^a-z\s-]/g, "").trim().split(/\s+/).filter(Boolean);
  const auto = suggested.length ? `${suggested[0]}.${suggested.slice(1).join("") || suggested[0]}@beamore.co.uk`.replace(/\.@/, "@") : "";

  if (state?.ok) {
    return (
      <div className="onboard-result">
        <h3>{state.name} is set up</h3>
        <ul className="steps-done">
          {state.steps?.map((s, i) => <li key={i} className={s.ok ? "ok" : "no"}>{s.ok ? "✓" : "!"} {s.label}{s.note && <span className="small muted"> — {s.note}</span>}</li>)}
        </ul>
        {state.password && (
          <p className="callout warn">
            Temporary password for <b>{state.email}</b>: <code className="mono" style={{ fontSize: 15 }}>{state.password}</code><br />
            <span className="small">{state.passwordSent ? `Also in the welcome email just sent to ${state.name?.split(" ")[0]}. ` : `Give it to ${state.name?.split(" ")[0]} by phone or text. `}Not saved anywhere; they choose their own when they first sign in.</span>
          </p>
        )}
        <p><Link className="btn primary" href={`/personnel/${state.clerkId}`}>Open {state.name}</Link></p>
      </div>
    );
  }

  return (
    <form action={action} className="form">
      {state?.message && <p className="callout bad">{state.message}</p>}
      <div className="row">
        <div className="field"><label htmlFor="nn">Name (as it will appear in the diary)</label>
          <input id="nn" name="name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Gareth Mayoh" /></div>
        <div className="field"><label htmlFor="pe">Their current email</label><input id="pe" name="personal_email" type="email" placeholder="their own address" /></div>
        <div className="field"><label htmlFor="be">New Beamore email</label>
          <input id="be" name="beamore_email" value={touched ? beamore : auto} onChange={(e) => { setTouched(true); setBeamore(e.target.value); }} placeholder="name.surname@beamore.co.uk" /></div>
        <div className="field"><label htmlFor="np">Mobile number</label><input id="np" name="phone" required placeholder="07…" /></div>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="nj">Going on</label>
          <select id="nj" name="project_id" defaultValue={defaultProject ?? ""}>
            <option value="">No particular project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
          </select></div>
        <div className="field"><label htmlFor="nr">As</label>
          <select id="nr" name="role" defaultValue={defaultRole === "me" ? "me" : "building"}><option value="building">Building clerk</option><option value="me">M&amp;E clerk</option></select></div>
        {director && <label className="small" style={{ alignSelf: "center" }}><input type="checkbox" name="create_account" defaultChecked /> Create their @beamore.co.uk Google account</label>}
        {director && <label className="small" style={{ alignSelf: "center" }}><input type="checkbox" name="send_welcome" defaultChecked /> Email them now at their current address</label>}
      </div>
      <p className="small muted">This creates their account (with their mobile for sign-in checks), shares their Personnel folder, the project folder and the Beamore manual with them, switches on the portal, emails them a welcome (sign-in details, 2-Step Verification, portal, folder, manual) at their current address, or saves it as a draft if you untick that, and puts sending their PPE on your list.</p>
      <button className="btn primary" disabled={busy}>{busy ? "Setting them up…" : "Add and set them up"}</button>
    </form>
  );
}
