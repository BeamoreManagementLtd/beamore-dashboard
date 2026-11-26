import { setAiFeedbackEmail } from "./actions";

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
 * The feedback is on for everyone now (Ronan, 26 Nov 2026: "turn it on for everyone and remove the option to turn it on
 * or off. Only give the option to receive it by email"). The one choice left is the email. Staff viewing as a clerk see
 * it but can't change it.
 */
export function AiSwitch({ email, viewingAs }: { email?: boolean; viewingAs?: boolean }) {
  const lock = viewingAs ? "Only the clerk can change this" : undefined;
  return (
    <form action={setAiFeedbackEmail} className="row" style={{ gap: 10, alignItems: "center" }}>
      <input type="hidden" name="on" value={email ? "0" : "1"} />
      <button className={`btn small ${email ? "" : "primary"}`} disabled={viewingAs} title={lock}>{email ? "Stop the emails" : "Email me the feedback"}</button>
      <span className="small muted">{email ? "On: you'll get an email from ai@beamore.co.uk with the feedback when each report has been sent." : "Optional: an email from ai@beamore.co.uk with the feedback when each report has been sent. Off unless you choose it."}</span>
    </form>
  );
}
