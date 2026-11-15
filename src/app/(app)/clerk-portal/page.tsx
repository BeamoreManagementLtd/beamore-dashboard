import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth";
import { insuranceSummary, fmtDate, gbp, type Policy } from "@/lib/portal/data";
import { aiConfigured } from "@/lib/portal/read-document";
import { resolveUpload, rereadUpload, removeUpload, setExpected, setAccess } from "./actions";

export const metadata = { title: "Clerk portal · Beamore" };

const TABS: [string, string][] = [["attention", "Needs attention"], ["uploads", "All uploads"], ["insurance", "Insurance register"], ["monthly", "Monthly invoices"], ["people", "People & access"], ["companies", "Company links"]];
const KIND: Record<string, string> = { invoice: "Invoice", company_invoice: "Company invoice", insurance: "Insurance", qualification: "Certificate" };
const STATUS: Record<string, [string, string]> = {
  received: ["Received", "neutral"], filed: ["Filed", "neutral"], checked: ["Read by AI", "neutral"], accepted: ["Checked", "good"],
  needs_correction: ["Clerk to fix", "bad"], needs_beamore: ["Beamore to look", "warn"], deleted: ["Removed", "neutral"],
};
const drive = (id: string | null) => (id ? `https://drive.google.com/file/d/${id}/view` : null);

type U = { id: string; receipt: string; clerk_id: string | null; email: string; kind: string; doc_type: string | null; file_name: string | null; received_at: string; status: string; issues: string[]; drive_file_id: string | null; ai_state: string | null; scan_note: string | null; period: string | null; source: string; correction_drafted_at: string | null; clerks: { name: string } | null };

export default async function ClerkPortalAdmin({ searchParams }: { searchParams: Promise<{ tab?: string; month?: string; who?: string }> }) {
  const me = await requireProfile();
  const director = me.role === "director";
  const { tab = "attention", month, who } = await searchParams;
  const db = await createClient();
  const sel = "id,receipt,clerk_id,email,kind,doc_type,file_name,received_at,status,issues,drive_file_id,ai_state,scan_note,period,source,correction_drafted_at,clerks(name)";

  const { data: counts } = await db.from("portal_uploads").select("status,ai_state,kind").neq("status", "deleted");
  const attention = (counts ?? []).filter((u) => ["needs_correction", "needs_beamore"].includes(u.status) || u.ai_state === "failed").length;
  const waitingAi = (counts ?? []).filter((u) => u.ai_state === "pending").length;

  return (
    <>
      <div className="head">
        <div><h1>Clerk portal</h1><p>What clerks upload at portal.beamore.co.uk: filed in their Personnel folders, read by AI, and fed into their records here.</p></div>
        <Link className="btn" href="/portal">Open the portal</Link>
      </div>
      {!aiConfigured() && <p className="callout warn">AI reading is off until the Claude API key (ANTHROPIC_API_KEY) is added in Vercel. Uploads are still saved and filed{waitingAi ? `; ${waitingAi} waiting to be read` : ""}.</p>}
      <nav className="wb-filters">
        {TABS.map(([k, label]) => <Link key={k} className={`btn${tab === k ? " primary" : ""}`} href={`/clerk-portal?tab=${k}`}>{label}{k === "attention" && attention ? ` (${attention})` : ""}</Link>)}
      </nav>

      {(tab === "attention" || tab === "uploads") && await (async () => {
        let q = db.from("portal_uploads").select(sel).neq("status", "uploading").order("received_at", { ascending: false });
        if (tab === "attention") q = q.or("status.eq.needs_correction,status.eq.needs_beamore,ai_state.eq.failed").neq("status", "deleted");
        if (who) q = q.eq("clerk_id", who);
        const { data } = await q.limit(300);
        const rows = (data ?? []) as unknown as U[];
        if (!rows.length) return <section className="panel"><p className="muted">{tab === "attention" ? "Nothing needs attention." : "No uploads yet."}</p></section>;
        return (
          <section className="panel tbl-wrap">
            <table>
              <thead><tr><th>Received</th><th>Who</th><th>What</th><th>File</th><th>Status</th><th>Issues</th><th></th></tr></thead>
              <tbody>
                {rows.map((u) => {
                  const [st, tone] = STATUS[u.status] ?? [u.status, "neutral"];
                  return (
                    <tr key={u.id}>
                      <td>{fmtDate(u.received_at)}{u.source === "legacy" && <div className="small muted">old portal</div>}</td>
                      <td>{u.clerk_id ? <Link href={`/personnel/${u.clerk_id}`}>{u.clerks?.name}</Link> : u.email}</td>
                      <td>{KIND[u.kind]}{u.doc_type ? `: ${u.doc_type}` : ""}{u.period ? ` (${u.period})` : ""}</td>
                      <td>{drive(u.drive_file_id) ? <a href={drive(u.drive_file_id)!} target="_blank" rel="noreferrer">{u.file_name ?? "Open in Drive"}</a> : <span className="muted">{u.file_name ?? "not filed yet"}</span>}</td>
                      <td><span className={`pill ${tone}`}>{st}</span>{u.ai_state === "failed" && <div className="small neg">AI couldn&apos;t read it</div>}</td>
                      <td className="small">{u.issues.join(". ") || "—"}{u.correction_drafted_at && <div className="muted">Draft to clerk in Gmail</div>}</td>
                      <td>
                        {u.status !== "deleted" && (
                          <div className="btn-row" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {["needs_correction", "needs_beamore"].includes(u.status) && <form action={resolveUpload}><input type="hidden" name="id" value={u.id} /><button className="btn">Resolved</button></form>}
                            {u.drive_file_id && u.kind !== "company_invoice" && <form action={rereadUpload}><input type="hidden" name="id" value={u.id} /><button className="btn">Read again</button></form>}
                            {director && <form action={removeUpload}><input type="hidden" name="id" value={u.id} /><input type="hidden" name="reason" value="Removed by Ronan" /><button className="btn">Remove</button></form>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })()}

      {tab === "insurance" && await (async () => {
        const [{ data: clerks }, { data: pols }] = await Promise.all([
          db.from("clerks").select("id,name,portal_access,active").eq("active", true).eq("portal_access", true).order("name"),
          db.from("insurance_policies").select("id,clerk_id,type,description,insurer,insured_name,cover_pence,starts,expires,upload_id,source"),
        ]);
        const by = new Map<string, Policy[]>();
        for (const p of (pols ?? []) as (Policy & { clerk_id: string })[]) { if (!by.has(p.clerk_id)) by.set(p.clerk_id, []); by.get(p.clerk_id)!.push(p); }
        const rows = (clerks ?? []).map((c) => ({ c, s: insuranceSummary(by.get(c.id) ?? []) })).sort((a, b) => Number(a.s.piOk) - Number(b.s.piOk) || a.c.name.localeCompare(b.c.name));
        const t = new Date().toISOString().slice(0, 10);
        const cell = (p?: Policy) => !p ? <span className="muted">—</span> : <span className={p.expires && p.expires >= t ? "" : "neg"}>{gbp(p.cover_pence)} · {fmtDate(p.expires)}</span>;
        return (
          <section className="panel tbl-wrap">
            <p className="muted small">{rows.filter((r) => r.s.piOk).length} of {rows.length} clerks have £1m PI in date.</p>
            <table>
              <thead><tr><th>Clerk</th><th>PI (required)</th><th>Public liability</th><th>Employers liability</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map(({ c, s }) => (
                  <tr key={c.id}>
                    <td><Link href={`/personnel/${c.id}`}>{c.name}</Link></td>
                    <td>{cell(s.latest.get("PI"))}</td><td>{cell(s.latest.get("PL"))}</td><td>{cell(s.latest.get("EL"))}</td>
                    <td><span className={`pill ${s.piOk ? "good" : "bad"}`}>{s.piOk ? "OK" : s.pi ? "PI needs updating" : "No PI on file"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })()}

      {tab === "monthly" && await (async () => {
        const m = /^\d{4}-\d{2}$/.test(month ?? "") ? month! : new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).toISOString().slice(0, 7);
        const [y, mo] = m.split("-").map(Number);
        const end = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
        const [{ data: clerks }, { data: visits }, { data: exp }, { data: ups }] = await Promise.all([
          db.from("clerks").select("id,name,invoices_paused,invoice_upload").eq("active", true).eq("portal_access", true).order("name"),
          db.from("diary_visits").select("clerk_id,days").eq("side", "charged").gte("visit_date", `${m}-01`).lte("visit_date", end),
          db.from("portal_expectations").select("clerk_id,expected").eq("period", m),
          db.from("portal_uploads").select("clerk_id,period,received_at,status").eq("kind", "invoice").neq("status", "deleted"),
        ]);
        const days = new Map<string, number>();
        for (const v of visits ?? []) days.set(v.clerk_id, (days.get(v.clerk_id) ?? 0) + Number(v.days));
        const ex = new Map((exp ?? []).map((e) => [e.clerk_id, e.expected]));
        const got = new Map<string, number>();
        for (const u of ups ?? []) if ((u.period ?? u.received_at.slice(0, 7)) === m) got.set(u.clerk_id, (got.get(u.clerk_id) ?? 0) + 1);
        const rows = (clerks ?? []).map((c) => {
          const d = days.get(c.id) ?? 0, set = ex.get(c.id);
          const expected = set ?? d > 0;
          return { c, d, expected, set, n: got.get(c.id) ?? 0 };
        }).filter((r) => r.expected || r.n || r.set === false);
        const prev = new Date(Date.UTC(y, mo - 2, 15)).toISOString().slice(0, 7), next = new Date(Date.UTC(y, mo, 15)).toISOString().slice(0, 7);
        const missing = rows.filter((r) => r.expected && !r.n).length;
        return (
          <section className="panel tbl-wrap">
            <div className="row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Link className="btn" href={`/clerk-portal?tab=monthly&month=${prev}`}>←</Link>
              <b>{new Date(`${m}-15`).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b>
              <Link className="btn" href={`/clerk-portal?tab=monthly&month=${next}`}>→</Link>
              <span className="muted small">Expected = clerks with charged days in the diary that month (or set by hand). {missing} still to come.</span>
            </div>
            <table>
              <thead><tr><th>Clerk</th><th className="num">Diary days</th><th>Invoice</th><th></th></tr></thead>
              <tbody>
                {rows.map(({ c, d, expected, n }) => (
                  <tr key={c.id}>
                    <td><Link href={`/personnel/${c.id}`}>{c.name}</Link>{c.invoices_paused && <span className="muted small"> · paused</span>}{!c.invoice_upload && <span className="muted small"> · emails invoices</span>}</td>
                    <td className="num">{d || "—"}</td>
                    <td>{n ? <span className="pill good">Received{n > 1 ? ` ×${n}` : ""}</span> : expected ? <span className="pill warn">Not yet</span> : <span className="pill neutral">Not working</span>}</td>
                    <td>
                      <form action={setExpected}>
                        <input type="hidden" name="period" value={m} /><input type="hidden" name="clerk" value={c.id} /><input type="hidden" name="expected" value={expected ? "0" : "1"} />
                        <button className="btn">{expected ? "Not working this month" : "Expect an invoice"}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })()}

      {tab === "people" && await (async () => {
        const { data: clerks } = await db.from("clerks").select("id,name,email,active,portal_access,invoice_upload,invoices_paused,billing").eq("active", true).order("name");
        const toggle = (c: { id: string }, field: string, on: boolean, label: [string, string]) => director
          ? <form action={setAccess}><input type="hidden" name="clerk" value={c.id} /><input type="hidden" name="field" value={field} /><input type="hidden" name="value" value={on ? "0" : "1"} /><button className={`btn${on ? " primary" : ""}`}>{on ? label[0] : label[1]}</button></form>
          : <span>{on ? label[0] : label[1]}</span>;
        return (
          <section className="panel tbl-wrap">
            <p className="muted small">Clerks sign in with their @beamore.co.uk Google account. Only Ronan and Judy get the dashboard; everyone else only sees their own portal.</p>
            <table>
              <thead><tr><th>Clerk</th><th>Email</th><th>Billing</th><th>Portal</th><th>Invoice upload</th><th>Invoices</th></tr></thead>
              <tbody>
                {(clerks ?? []).map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/personnel/${c.id}`}>{c.name}</Link></td>
                    <td className="small">{c.email ?? <span className="neg">no email</span>}</td>
                    <td className="small">{c.billing ?? "—"}</td>
                    <td>{toggle(c, "portal_access", c.portal_access, ["Access on", "No access"])}</td>
                    <td>{toggle(c, "invoice_upload", c.invoice_upload, ["Allowed", "Not allowed"])}</td>
                    <td>{toggle(c, "invoices_paused", c.invoices_paused, ["Paused", "Active"])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })()}

      {tab === "companies" && await (async () => {
        const { data } = await db.from("clerk_companies").select("id,company_name,relationship,status,email,clerk_id,clerks(name)").order("company_name");
        const rows = (data ?? []) as unknown as { id: string; company_name: string; relationship: string | null; status: string | null; email: string | null; clerk_id: string | null; clerks: { name: string } | null }[];
        return (
          <section className="panel tbl-wrap">
            <p className="muted small">The Xero contacts each clerk invoices through. Enabled links let the clerk see their payment history, and the insurance check accepts certificates in these company names.</p>
            <table>
              <thead><tr><th>Company</th><th>Clerk</th><th>Type</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.company_name}</td>
                    <td>{r.clerk_id ? <Link href={`/personnel/${r.clerk_id}`}>{r.clerks?.name}</Link> : <span className="muted">{r.email ?? "—"}</span>}</td>
                    <td className="small">{r.relationship ?? "—"}</td>
                    <td><span className={`pill ${r.status === "Enabled" ? "good" : r.status === "Revoked" ? "neutral" : "warn"}`}>{r.status ?? "—"}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })()}
    </>
  );
}
