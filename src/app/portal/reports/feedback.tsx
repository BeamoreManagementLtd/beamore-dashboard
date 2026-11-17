import { setAiFeedback } from "./actions";

/** What the clerk is told before and while they see the AI feedback (Ronan's words, 17 Nov 2026). */
export function AiNote() {
  return (
    <p className="small muted" style={{ margin: "4px 0 10px" }}>
      This is AI feedback, based on what Beamore asks for in a report. It&apos;s there to help, not to judge, so please don&apos;t take
      it all to heart. AI can make mistakes, and some points may not apply to your job or your report: if something looks wrong,
      just ignore it (or let us know).
    </p>
  );
}

/** The on/off switch. Staff viewing as a clerk see it but can't change it. */
export function AiSwitch({ on, viewingAs }: { on: boolean; viewingAs?: boolean }) {
  return (
    <form action={setAiFeedback} className="row" style={{ gap: 10, alignItems: "center" }}>
      <input type="hidden" name="on" value={on ? "0" : "1"} />
      <button className={`btn ${on ? "" : "primary"}`} disabled={viewingAs} title={viewingAs ? "Only the clerk can change this" : undefined}>
        {on ? "Turn off AI feedback" : "Show me the AI feedback on my reports"}
      </button>
      <span className="small muted">{on ? "On: you can see the feedback on each report under Your reports." : "Off: nothing changes until you switch it on."}</span>
    </form>
  );
}
