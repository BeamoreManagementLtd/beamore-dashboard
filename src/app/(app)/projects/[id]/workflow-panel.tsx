import type { Stage, Status, Step } from "@/lib/workflow";
import { markStep, setOutcome, setClerk, setPo, closeOutAnswer } from "../actions";

/** The project's workflow: stages across the top, then the current stage's steps (green done, amber waiting, grey to come). */
const WHO = { us: "Waiting on us", client: "Waiting on the client", you: "Waiting on you", admin: "Waiting on the admin team", clerk: "Waiting on the clerk" } as const;

export function WorkflowPanel({ projectId, stages, current, clerks, ticked, status }: {
  projectId: string; status: Status; stages: Stage[]; current: string; clerks: { id: string; name: string }[]; ticked: Set<string>;
}) {
  const open = stages.find((s) => s.state === "now") ?? stages[stages.length - 1];
  const count = (s: Stage) => `${s.steps.filter((x) => x.state === "done").length} of ${s.steps.length}`;

  const controls = (st: Step) => {
    if (st.id === "P5" && st.state !== "done")
      return (
        <span className="wf-ctl">
          <form action={setOutcome.bind(null, projectId)}><input type="hidden" name="outcome" value="won" /><button className="btn primary">Won</button></form>
          <form action={setOutcome.bind(null, projectId)} className="wf-inline"><input type="hidden" name="outcome" value="lost" />
            <input name="reason" placeholder="Reason (optional)" aria-label="Reason lost" /><button className="btn">Lost</button></form>
        </span>
      );
    if (st.id === "S3" && st.state !== "done")
      return (
        <form action={setClerk.bind(null, projectId)} className="wf-ctl wf-inline">
          <select name="clerk" aria-label="Clerk of works" defaultValue="">
            <option value="" disabled>Choose clerk…</option>
            {clerks.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value="finding">We need to find one</option>
          </select>
          <button className="btn">Save</button>
        </form>
      );
    if (st.id === "S6" && st.state !== "done")
      return (
        <form action={setPo.bind(null, projectId)} className="wf-ctl wf-inline">
          <input name="po" placeholder="PO number" aria-label="PO number" /><button className="btn">Save</button>
        </form>
      );
    if (st.id === "X2" && st.state !== "done")
      return (
        <span className="wf-ctl">
          {(["finished", "paused", "going"] as const).map((a) => (
            <form key={a} action={closeOutAnswer.bind(null, projectId, a)}><button className="btn">{a === "finished" ? "Finished" : a === "paused" ? "Paused" : "Still going"}</button></form>
          ))}
        </span>
      );
    if (st.manual && st.state !== "done" && st.state !== "skip")
      return <form action={markStep.bind(null, projectId, st.id, true)} className="wf-ctl"><button className="btn">Mark done</button></form>;
    if (ticked.has(st.id) && st.id !== "X2")
      return <form action={markStep.bind(null, projectId, st.id, false)} className="wf-ctl"><button className="linklike small">undo</button></form>;
    return null;
  };

  return (
    <section className="panel wf">
      <div className="wf-status">
        {status.waitingOn && <span className={`pill ${status.waitingOn === "client" ? "neutral" : "warn"}`}>{WHO[status.waitingOn]}{status.days ? ` · ${status.days} day${status.days === 1 ? "" : "s"}` : ""}</span>}
        <p>{status.text}</p>
        {status.extra?.map((e) => <p key={e} className="small muted">{e}</p>)}
      </div>
      <div className="wf-stages">
        {stages.map((s) => (
          <span key={s.key} className={`wf-stage ${s.state}`}>{s.title}{s.state === "done" ? " ✓" : s.state === "now" ? ` · ${count(s)}` : ""}</span>
        ))}
        {current === "lost" && <span className="wf-stage lost">Lost</span>}
        {current === "complete" && <span className="wf-stage done">Complete ✓</span>}
      </div>
      {stages.filter((s) => s === open || s.state === "now").map((s) => (
        <ol key={s.key} className="wf-steps">
          {s.steps.map((st) => (
            <li key={st.id} className={st.state}>
              <span className="wf-id">{st.id}</span>
              <span className="wf-title">{st.title}</span>
              {st.note && <span className="wf-note">{st.note}</span>}
              {controls(st)}
            </li>
          ))}
        </ol>
      ))}
      <details className="wf-all">
        <summary>All stages</summary>
        {stages.filter((s) => s !== open).map((s) => (
          <div key={s.key}>
            <h3>{s.title} <span className="muted small">{count(s)}</span></h3>
            <ol className="wf-steps">
              {s.steps.map((st) => (
                <li key={st.id} className={st.state}><span className="wf-id">{st.id}</span><span className="wf-title">{st.title}</span>{st.note && <span className="wf-note">{st.note}</span>}{controls(st)}</li>
              ))}
            </ol>
          </div>
        ))}
      </details>
    </section>
  );
}
