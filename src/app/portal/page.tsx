import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { myUploads, myPolicies, insuranceSummary, fmtDate, clerkStatus } from "@/lib/portal/data";

export default async function PortalHome() {
  const me = await requirePortalUser();
  if (!me.clerk) {
    return (
      <section className="card">
        <h1>Clerk portal</h1>
        <p className="muted">You&apos;re signed in as staff. Clerks see their invoices, insurance and certificates here.</p>
        <p><Link className="btn primary" href="/clerk-portal">Open portal admin</Link></p>
      </section>
    );
  }
  const db = createServiceClient();
  const [uploads, policies, { data: comp }] = await Promise.all([
    myUploads(db, me.clerk.id),
    myPolicies(db, me.clerk.id),
    db.from("clerk_compliance").select("cscs_expiry,chartership_body,chartership_renewal").eq("clerk_id", me.clerk.id).maybeSingle(),
  ]);
  const ins = insuranceSummary(policies);
  const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).toISOString().slice(0, 7);
  const invoices = uploads.filter((u) => u.kind === "invoice");
  const thisRound = invoices.filter((u) => (u.period ?? u.received_at.slice(0, 7)) >= lastMonth);
  const todo = uploads.filter((u) => u.status === "needs_correction");
  const first = me.clerk.name.split(" ")[0];

  return (
    <>
      <section className="portal-hello">
        <h1>Hello {first}</h1>
        <p className="muted">Send us your invoices, insurance and certificates here. Everything you upload is saved straight away; we check it afterwards.</p>
      </section>

      {!!todo.length && (
        <section className="callout bad">
          <b>We need {todo.length === 1 ? "one thing" : `${todo.length} things`} from you</b>
          <ul>{todo.map((u) => <li key={u.id}>{u.file_name}: {u.issues[0] ?? "please upload a clearer or complete copy"}</li>)}</ul>
        </section>
      )}

      <section className="portal-cards">
        <Link href="/portal/invoices" className="pcard">
          <span className="label">Invoices</span>
          <b>{me.clerk.invoices_paused ? "Paused" : thisRound.length ? `${thisRound.length} received recently` : "Nothing received yet this month"}</b>
          <span className="muted small">{invoices[0] ? `Last sent ${fmtDate(invoices[0].received_at)}` : "Upload your monthly invoice"}</span>
          <span className="pcard-go">Upload invoice →</span>
        </Link>
        <Link href="/portal/insurance" className={`pcard ${ins.piOk ? "ok" : "warn"}`}>
          <span className="label">Insurance</span>
          <b>{ins.piOk ? "In date" : "Action needed"}</b>
          <span className="muted small">{ins.piText}</span>
          <span className="pcard-go">Upload certificate →</span>
        </Link>
        <Link href="/portal/certificates" className="pcard">
          <span className="label">Certificates & qualifications</span>
          <b>{uploads.filter((u) => u.kind === "qualification").length} on file</b>
          <span className="muted small">{comp?.cscs_expiry ? `CSCS card expires ${fmtDate(comp.cscs_expiry)}` : "CSCS card, MCIOB, MICWCI and others"}</span>
          <span className="pcard-go">Upload certificate →</span>
        </Link>
      </section>

      <section className="card">
        <h2>Recent uploads</h2>
        {uploads.length ? (
          <table className="ptable">
            <thead><tr><th>Received</th><th>What</th><th>File</th><th>Status</th></tr></thead>
            <tbody>
              {uploads.slice(0, 8).map((u) => {
                const s = clerkStatus(u);
                return (
                  <tr key={u.id}>
                    <td>{fmtDate(u.received_at)}</td>
                    <td>{u.kind === "invoice" ? "Invoice" : u.kind === "insurance" ? "Insurance" : u.doc_type ?? "Certificate"}</td>
                    <td className="clip">{u.file_name ?? "—"}</td>
                    <td><span className={`pill ${s.tone}`}>{s.text}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">Nothing uploaded yet.</p>}
      </section>
    </>
  );
}
