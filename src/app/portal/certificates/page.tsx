import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { myUploads, fmtDate, clerkStatus, QUAL_TYPES } from "@/lib/portal/data";
import { UploadBox } from "../upload-box";

export default async function PortalCertificates() {
  const me = await requirePortalUser();
  if (!me.clerk) return <p className="muted">Clerks only.</p>;
  const db = createServiceClient();
  const [uploads, { data: comp }] = await Promise.all([
    myUploads(db, me.clerk.id, ["qualification"]),
    db.from("clerk_compliance").select("cscs_number,cscs_expiry,chartership_body,chartership_grade,chartership_number").eq("clerk_id", me.clerk.id).maybeSingle(),
  ]);
  const t = new Date().toISOString().slice(0, 10);

  return (
    <>
      <section className="portal-hello">
        <h1>Certificates &amp; qualifications</h1>
        <p className="muted">Keep copies of your CSCS card, MCIOB, MICWCI, MCABE and other qualifications here. They&apos;re filed in your own folder at Beamore.</p>
      </section>

      {(comp?.cscs_expiry || comp?.chartership_body) && (
        <section className="portal-cards">
          {comp?.cscs_expiry && (
            <div className={`pcard ${comp.cscs_expiry >= t ? "ok" : "warn"}`}>
              <span className="label">CSCS card</span>
              <b>{comp.cscs_expiry >= t ? "In date" : "Expired"}</b>
              <span className="muted small">{comp.cscs_number ? `No. ${comp.cscs_number} · ` : ""}expires {fmtDate(comp.cscs_expiry)}</span>
            </div>
          )}
          {comp?.chartership_body && (
            <div className="pcard ok">
              <span className="label">Membership</span>
              <b>{comp.chartership_body}{comp.chartership_grade ? ` · ${comp.chartership_grade}` : ""}</b>
              <span className="muted small">{comp.chartership_number ? `No. ${comp.chartership_number}` : "On file"}</span>
            </div>
          )}
        </section>
      )}

      <UploadBox kind="qualification" title="Upload a certificate or card" hint="PDF or a photo. Choose what it is first; we read the details for you." types={QUAL_TYPES} button="Choose file" />

      <section className="card">
        <h2>On file</h2>
        {uploads.length ? (
          <table className="ptable">
            <thead><tr><th>Received</th><th>What</th><th>File</th><th>Status</th></tr></thead>
            <tbody>
              {uploads.map((u) => {
                const s = clerkStatus(u);
                return (
                  <tr key={u.id}>
                    <td>{fmtDate(u.received_at)}</td>
                    <td>{u.doc_type ?? "Certificate"}</td>
                    <td className="clip">{u.file_name ?? "—"}</td>
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
