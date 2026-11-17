import { setAiFeedback, setAiFeedbackEmail } from "./actions";

/** What the clerk is told before and while they see the AI feedback (Ronan's words, 17 Nov 2026). */
export function AiNote() {
  return (
    <p className="small muted" style={{ margin: "4px 0 10px" }}>
      This is AI feedback, based on what Beamore asks for in a report. It&apos;s there to help, not to judge, so please don&apos;t take
      it all to heart. AI can make mistakes, and some points may not apply to your job or your report: if something looks wrong,
      just ignore it (or let us know). The score is only there so you can see your own improvement over time, not to compare
      with anyone else.
    </p>
  );
}

/**
 * The on/off switches: the feedback itself, then (only once that's on) the emails, which are their own choice (Ronan,
 * 17 Nov 2026). Staff viewing as a clerk see them but can't change them.
 */
export function AiSwitch({ on, email, viewingAs }: { on: boolean; email?: boolean; viewingAs?: boolean }) {
  const lock = viewingAs ? "Only the clerk can change this" : undefined;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <form action={setAiFeedback} className="row" style={{ gap: 10, alignItems: "center" }}>
        <input type="hidden" name="on" value={on ? "0" : "1"} />
        <button className={`btn ${on ? "" : "primary"}`} disabled={viewingAs} title={lock}>
          {on ? "Turn off AI feedback" : "Show me the AI feedback on my reports"}
        </button>
        <span className="small muted">{on ? "On: you can see the feedback on each report under Your reports." : "Off: nothing changes until you switch it on."}</span>
      </form>
      {on && (
        <form action={setAiFeedbackEmail} className="row" style={{ gap: 10, alignItems: "center" }}>
          <input type="hidden" name="on" value={email ? "0" : "1"} />
          <button className="btn small" disabled={viewingAs} title={lock}>{email ? "Stop the emails" : "Also email me the feedback"}</button>
          <span className="small muted">{email ? "On: you'll get an email from ai@beamore.co.uk with the feedback when each report has been sent." : "Optional: an email from ai@beamore.co.uk with the feedback when each report has been sent. Off unless you choose it."}</span>
        </form>
      )}
    </div>
  );
}
