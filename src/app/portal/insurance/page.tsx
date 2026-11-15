import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { myUploads, myPolicies, insuranceSummary, fmtDate, gbp, clerkStatus } from "@/lib/portal/data";
import { UploadBox } from "../upload-box";

const LABEL: Record<string, string> = { PI: "Professional indemnity", PL: "Public liability", EL: "Employers liability", other: "Other" };

export default async function PortalInsurance() {
  const me = await requirePortalUser();
  if (!me.clerk) return <p className="muted">Clerks only.</p>;
  const db = createServiceClient();
  const [uploads, policies] = await Promise.all([myUploads(db, me.clerk.id, ["insurance"]), myPolicies(db, me.clerk.id)]);
  const ins = insuranceSummary(policies);
  const t = new Date().toISOString().slice(0, 10);

  return (
    <>
      <section className="portal-hello">
        <h1>Insurance</h1>
        <p className="muted">Beamore needs at least £500,000 of professional indemnity (PI) cover. Public liability and employers liability are optional; any public liability cover must be at least £1 million.</p>
      </section>

      <section className={`status-banner ${ins.piOk ? "good" : "warn"}`}>
        <b>{ins.piOk ? "✓ Your insurance is in date" : "Action needed"}</b>
        <span>{ins.piText}</span>
      </section>

      <UploadBox kind="insurance" title="Upload an insurance certificate" hint="PDF or a photo of your certificate or schedule. You don't need to type in amounts or dates: we read them for you." button="Choose certificate" />

      <section className="card">
        <h2>Your cover</h2>
        {ins.latest.size ? (
          <table className="ptable">
            <thead><tr><th>Cover</th><th>Insured</th><th className="num">Amount</th><th>From</th><th>To</th><th>Status</th></tr></thead>
            <tbody>
              {[...ins.latest.values()].map((p) => {
                const ok = p.expires && p.expires >= t;
                return (
                  <tr key={p.id}>
                    <td>{LABEL[p.type] ?? p.type}{p.type === "other" && p.description ? `: ${p.description}` : ""}</td>
                    <td className="clip">{p.insured_name ?? "—"}</td>
                    <td className="num">{gbp(p.cover_pence)}</td>
                    <td>{fmtDate(p.starts)}</td>
                    <td>{fmtDate(p.expires)}</td>
                    <td>{ok ? <span className="pill good">Current</span> : <span className="pill bad">{p.expires ? "Expired" : "Date not read"}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">No cover recorded yet. Upload your certificate above.</p>}
      </section>

      <section className="card">
        <h2>Certificates you&apos;ve uploaded</h2>
        {uploads.length ? (
          <table className="ptable">
            <thead><tr><th>Received</th><th>File</th><th>Status</th></tr></thead>
            <tbody>
              {uploads.map((u) => {
                const s = clerkStatus(u);
                return (
                  <tr key={u.id}>
                    <td>{fmtDate(u.received_at)}</td>
                    <td className="clip">{u.file_name ?? "Insurance certificate"}</td>
                    <td><span className={`pill ${s.tone}`}>{s.text}</span>{u.status === "needs_correction" && u.issues[0] && <div className="small muted">{u.issues.join(". ")}</div>}</td>
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
