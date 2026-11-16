import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { EmailBox } from "../email/email-box";
import type { Composed } from "../email/actions";

export const dynamic = "force-dynamic";

const WHAT: Record<string, string> = {
  info: "Project information request", "portal-correction": "Portal upload needs correcting", renewal: "Renewal due (CSCS / DBS)",
  "insurance-renewal": "Insurance renewal reminder",
};
const fdt = (d: string) => new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });

/**
 * Emails the dashboard wrote by itself (Ronan, 16 Nov 2026): each waits here to be read, changed if need be, and sent
 * from your own Gmail, saved to Gmail Drafts, copied, or marked not needed. Insurance renewal reminders send
 * themselves and are listed under "Done" as a record.
 */
export default async function EmailsPage() {
  await requireProfile();
  const db = createServiceClient();
  const [{ data: waiting }, { data: done }] = await Promise.all([
    db.from("email_outbox").select("*, projects(number,name), clerks(name)").eq("status", "waiting").order("created_at", { ascending: false }),
    db.from("email_outbox").select("id,kind,to_email,subject,status,done_at,note,projects(number,name),clerks(name),profiles:done_by(full_name)").neq("status", "waiting").order("done_at", { ascending: false }).limit(60),
  ]);
  type Row = { id: string; kind: string; to_email: string; cc: string | null; subject: string; body: string; thread_id: string | null; in_reply_to: string | null; project_id: string | null; clerk_id: string | null; created_at: string; projects: { number: number; name: string } | null; clerks: { name: string } | null };
  return (
    <div>
      <h1>Emails to send</h1>
      <p className="muted">Emails the dashboard has written by itself. Read each one, change anything you like, then send it from your own Gmail, save it to Gmail Drafts, or copy it. Nothing goes until someone presses Send. Insurance renewal reminders send themselves (a week before, on the day, then weekly) and are listed under Done.</p>
      {!waiting?.length && <p className="callout good">Nothing waiting.</p>}
      {(waiting as Row[] | null ?? []).map((w) => {
        const initial: Composed = {
          to: w.to_email, cc: w.cc ?? undefined, subject: w.subject, body: w.body, threadId: w.thread_id ?? undefined, inReplyTo: w.in_reply_to ?? undefined,
          kind: w.kind === "info" ? "info" : "other", ref: w.kind === "info" ? (w.project_id ?? "") : "", outboxId: w.id,
        };
        return (
          <section key={w.id} className="panel" style={{ marginBottom: 14 }}>
            <h2 style={{ marginBottom: 4 }}>{WHAT[w.kind] ?? w.kind}
              {w.projects && <> · <Link href={`/projects/${w.project_id}`}>{w.projects.number} {w.projects.name}</Link></>}
              {w.clerks && <> · <Link href={`/personnel/${w.clerk_id}`}>{w.clerks.name}</Link></>}</h2>
            <p className="small muted" style={{ margin: 0 }}>Written {fdt(w.created_at)}{!w.to_email ? ". No address found: add one in To before sending" : ""}</p>
            <EmailBox kind={initial.kind} refId={initial.ref} label="" initial={initial} />
          </section>
        );
      })}
      {!!done?.length && <details className="panel" style={{ marginTop: 18 }}>
        <summary><b>Done</b> <span className="small muted">(last {done.length})</span></summary>
        <table><tbody>{(done as unknown as { id: string; kind: string; to_email: string; subject: string; status: string; done_at: string | null; note: string | null; projects: { number: number; name: string } | null; clerks: { name: string } | null; profiles: { full_name: string | null } | null }[]).map((d) => (
          <tr key={d.id}>
            <td className="small muted" style={{ whiteSpace: "nowrap" }}>{d.done_at ? fdt(d.done_at) : ""}</td>
            <td className="small"><span className={`pill ${d.status === "sent" ? "good" : d.status === "dismissed" ? "muted" : "warn"}`}>{d.status === "sent" ? (d.note ?? "Sent") : d.status === "drafted" ? "In Gmail Drafts" : "Not needed"}</span>{d.profiles?.full_name ? ` by ${d.profiles.full_name.split(" ")[0]}` : ""}</td>
            <td className="small">{WHAT[d.kind] ?? d.kind}{d.clerks ? ` · ${d.clerks.name}` : ""}{d.projects ? ` · ${d.projects.number} ${d.projects.name}` : ""}</td>
            <td className="small">{d.subject} <span className="muted">to {d.to_email || "?"}</span></td>
          </tr>
        ))}</tbody></table>
      </details>}
    </div>
  );
}
