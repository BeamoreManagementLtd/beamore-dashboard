import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { monthComparison, monthLabel } from "@/lib/signoff";
import { gbp, fdt } from "@/lib/format";
import { prepare, approve } from "./actions";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Draft = {
  id: string; status: string; invoice_number: string | null; contact_name: string | null; reference: string | null;
  days_building: number; days_me: number; total_net: number | null; warnings: string[]; note: string | null;
  lines: { text: string; qty: number | null; rate: number | null }[] | null; projects: { display_name: string } | null;
};
const STATUS: Record<string, [string, string]> = {
  prepared: ["neutral", "Ready to create"], created: ["good", "Draft in Xero"], skipped: ["warn", "Not drafted"], error: ["bad", "Xero error"],
};

export default async function SignOff({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireProfile();
  const sp = await searchParams;
  const now = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  // default: last month until the 10th, then this month
  const def = Number(now.slice(8, 10)) <= 10 ? new Date(Date.UTC(+now.slice(0, 4), +now.slice(5, 7) - 2, 1)).toISOString().slice(0, 7) : now.slice(0, 7);
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : def;
  const m = `${ym}-01`;
  const db = await createClient();
  const director = me.role === "director";
  const [rows, { data: signoff }, { data: drafts }] = await Promise.all([
    monthComparison(db, m),
    db.from("month_signoffs").select("approved_at,profiles(full_name)").eq("month", m).maybeSingle(),
    director ? db.from("invoice_drafts").select("*,projects(display_name)").eq("month", m).order("status").order("invoice_number") : Promise.resolve({ data: null }),
  ]);
  const ds = (drafts ?? []) as unknown as Draft[];
  const ready = ds.filter((d) => d.status === "prepared");
  const shift = (n: number) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 7);
  const tot = (k: keyof (typeof rows)[number]) => rows.filter((r) => r.projectId).reduce((s, r) => s + Number(r[k]), 0);
  const hasPlan = rows.some((r) => r.plannedB + r.plannedMe > 0);

  return (
    <>
      <div className="head">
        <div><h1>Month sign-off: {monthLabel(m)}</h1><p>The diary’s planned (grey) days against what clerks charged (salmon), then draft invoices for Xero.</p></div>
        <div className="row">
          <a className="btn" href={`/signoff?month=${shift(-1)}`}>← {monthLabel(`${shift(-1)}-01`)}</a>
          <a className="btn" href={`/signoff?month=${shift(1)}`}>{monthLabel(`${shift(1)}-01`)} →</a>
        </div>
      </div>
      {sp.error && <p className="callout bad">{sp.error}</p>}
      {sp.done === "prepared" && <p className="callout info">{sp.n} draft{sp.n === "1" ? "" : "s"} ready to check below; {sp.s} project{sp.s === "1" ? "" : "s"} not drafted (see why).</p>}
      {sp.done === "created" && <p className="callout info">{sp.n} draft invoice{sp.n === "1" ? "" : "s"} created in Xero{Number(sp.f) ? `; ${sp.f} failed (see below)` : ""}. Review and approve them in Xero.</p>}
      {signoff && <p className="callout info">Signed off {fdt(signoff.approved_at)} by {(signoff.profiles as unknown as { full_name: string } | null)?.full_name ?? "the director"}.</p>}
      {!hasPlan && rows.length > 0 && <p className="callout warn">No planned (grey) days in the diary for {monthLabel(m)}, so there’s nothing to compare against. The grey side starts with November 2026.</p>}

      <section className="panel">
        <h2>Planned vs charged</h2>
        {!rows.length ? <p className="empty">No diary days for this month yet.</p> : (
          <div className="tbl-wrap"><table>
            <thead><tr><th>Project</th><th>Client</th><th className="num">Planned</th><th className="num">Charged</th><th className="num">Difference</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const pl = r.plannedB + r.plannedMe, ch = r.chargedB + r.chargedMe, diff = ch - pl;
                return (
                  <tr key={r.projectId ?? "none"} className={r.projectId ? "" : "muted"}>
                    <td><b>{r.name}</b></td>
                    <td>{r.client}</td>
                    <td className="num">{pl || "—"}{r.plannedMe ? <span className="two">{r.plannedB} bldg · {r.plannedMe} M&amp;E</span> : null}</td>
                    <td className="num">{ch || "—"}{r.chargedMe ? <span className="two">{r.chargedB} bldg · {r.chargedMe} M&amp;E</span> : null}</td>
                    <td className={`num ${hasPlan && diff ? (diff > 0 ? "neg" : "warn") : ""}`}>{hasPlan && pl ? (diff > 0 ? `+${diff}` : diff || "✓") : "—"}</td>
                  </tr>
                );
              })}
              <tr><td><b>Total</b></td><td /><td className="num"><b>{tot("plannedB") + tot("plannedMe")}</b></td><td className="num"><b>{tot("chargedB") + tot("chargedMe")}</b></td><td /></tr>
            </tbody>
          </table></div>
        )}
      </section>

      {director && (
        <section className="panel">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h2>Draft invoices</h2>
              <p className="small muted">Each draft copies the project’s last invoice (contact, wording, PO, account and VAT) with this month’s charged days, the Rates tab price and the next number for that client. They’re created as drafts only: you approve and send them in Xero.</p>
            </div>
            <div className="row">
              <form action={prepare.bind(null, m)}><button className="btn">{ds.length ? "Prepare again" : "Prepare drafts"}</button></form>
              {ready.length > 0 && (
                <form action={approve.bind(null, m)}><button className="btn primary">Approve {monthLabel(m)} and create {ready.length} draft{ready.length > 1 ? "s" : ""} in Xero</button></form>
              )}
            </div>
          </div>
          {!ds.length ? <p className="empty">Not prepared yet.</p> : (
            <div className="tbl-wrap"><table>
              <thead><tr><th>Invoice</th><th>Project</th><th>Lines</th><th className="num">Net</th><th>Status</th></tr></thead>
              <tbody>
                {ds.map((d) => (
                  <tr key={d.id}>
                    <td className="mono">{d.invoice_number ?? "—"}<span className="two">{d.contact_name}</span></td>
                    <td><b>{d.projects?.display_name}</b><span className="two">{d.reference}</span></td>
                    <td className="small">
                      {(d.lines ?? []).filter((l) => l.qty).map((l, i) => <div key={i}>{l.qty} × {gbp(l.rate)}: {l.text.split("\n")[0]}</div>)}
                      {d.warnings.map((w, i) => <div key={i} className="neg">⚠ {w}</div>)}
                    </td>
                    <td className="num">{gbp(d.total_net)}</td>
                    <td><span className={`pill ${STATUS[d.status][0]}`}>{STATUS[d.status][1]}</span><span className="two">{d.note}</span></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      )}
    </>
  );
}
