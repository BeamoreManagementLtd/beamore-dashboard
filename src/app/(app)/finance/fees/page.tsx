import Link from "next/link";
import { requireDirector } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp } from "@/lib/format";

export const dynamic = "force-dynamic";

type Fee = { project_id: string | null; month: string; invoices: number; invoiced_net: number; paid: number; outstanding: number; credited: number };
const label = (m: string) => new Date(m + "T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });

/** Fees by project for the financial year (from 1 Dec 2025), from Xero's invoices. Director only; reads only. */
export default async function Fees({ searchParams }: { searchParams: Promise<{ sort?: string }> }) {
  await requireDirector();
  const { sort = "invoiced" } = await searchParams;
  const db = await createClient();
  const [{ data: fees }, { data: projects }, { data: days }, { data: snap }] = await Promise.all([
    db.from("project_fees").select("*"),
    db.from("projects").select("id,display_name,stage,clients(name)"),
    db.from("project_diary_days").select("project_id,charged_to_date"),
    db.from("finance_snapshots").select("period,sales").like("period", "FY%").limit(1),
  ]);
  const f = (fees ?? []) as Fee[];
  const pm = new Map((projects ?? []).map((p) => [p.id, p]));
  const dm = new Map((days ?? []).map((d) => [d.project_id as string, Number(d.charged_to_date ?? 0)]));
  const months = [...new Set(f.map((x) => x.month))].sort();

  const byProject = new Map<string, { net: number; paid: number; out: number; n: number; credited: number; months: Map<string, number> }>();
  for (const x of f) {
    const k = x.project_id ?? "none";
    const p = byProject.get(k) ?? { net: 0, paid: 0, out: 0, n: 0, credited: 0, months: new Map() };
    p.net += Number(x.invoiced_net ?? 0); p.paid += Number(x.paid); p.out += Number(x.outstanding); p.n += Number(x.invoices); p.credited += Number(x.credited);
    p.months.set(x.month, (p.months.get(x.month) ?? 0) + Number(x.invoiced_net ?? 0));
    byProject.set(k, p);
  }
  const rows = [...byProject].filter(([k]) => k !== "none").sort(([, a], [, b]) =>
    sort === "outstanding" ? b.out - a.out : sort === "perday" ? 0 : b.net - a.net);
  if (sort === "perday") rows.sort(([ka, a], [kb, b]) => (b.net / (dm.get(kb) || Infinity)) - (a.net / (dm.get(ka) || Infinity)));
  const none = byProject.get("none");
  const tot = [...byProject.values()].reduce((s, x) => ({ net: s.net + x.net, paid: s.paid + x.paid, out: s.out + x.out, n: s.n + x.n }), { net: 0, paid: 0, out: 0, n: 0 });
  const monthTot = (m: string) => f.filter((x) => x.month === m).reduce((s, x) => s + Number(x.invoiced_net ?? 0), 0);
  const pl = snap?.[0]?.sales;
  // credit notes are recorded against invoices including VAT; at the year's own VAT ratio they come off net sales
  const gross = f.reduce((s, x) => s + Number((x as unknown as { invoiced_gross: number }).invoiced_gross ?? 0), 0);
  const credNet = gross ? f.reduce((s, x) => s + Number(x.credited), 0) * (tot.net / gross) : 0;

  return (
    <>
      <Link href="/finance" className="small">← Finance</Link>
      <div className="head">
        <div><h1>Fees by project</h1><p>Sales invoices from 1 December 2025 (this financial year), from Xero, ex VAT. Read only: nothing in Xero is changed.</p></div>
        <span className="ronly">Director only</span>
      </div>
      {!f.length ? <p className="callout info">No invoices loaded yet. They arrive with the next Xero sync (Finance → Sync now).</p> : (
        <>
          <div className="tiles">
            <div className="tile"><span className="label">Invoiced (net)</span><span className="big">{gbp(tot.net)}</span>
              <span className="sub">{tot.n} invoices{credNet ? ` · less credit notes ${gbp(credNet)} = ${gbp(tot.net - credNet)}` : ""}{pl ? ` · P&L sales ${gbp(pl)}` : ""}</span></div>
            <div className="tile"><span className="label">Paid</span><span className="big">{gbp(tot.paid)}</span><span className="sub">incl. VAT</span></div>
            <div className={`tile ${tot.out ? "alert" : ""}`}><span className="label">Outstanding</span><span className="big">{gbp(tot.out)}</span><span className="sub">incl. VAT</span></div>
            <div className={`tile ${none?.net ? "alert" : ""}`}><span className="label">Not linked to a project</span><span className="big">{gbp(none?.net ?? 0)}</span><span className="sub">{none?.n ?? 0} invoices</span></div>
          </div>
          <section className="panel">
            <h2>By month</h2>
            <div className="tbl-wrap"><table>
              <thead><tr>{months.map((m) => <th key={m} className="num">{label(m)}</th>)}</tr></thead>
              <tbody><tr>{months.map((m) => <td key={m} className="num">{gbp(monthTot(m))}</td>)}</tr></tbody>
            </table></div>
          </section>
          <section className="panel">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <h2>By project</h2>
              <nav className="row">
                {[["invoiced", "Most invoiced"], ["outstanding", "Most outstanding"], ["perday", "Highest £ per day"]].map(([k, l]) => (
                  <Link key={k} href={`/finance/fees?sort=${k}`} className={`btn ${sort === k ? "primary" : ""}`}>{l}</Link>
                ))}
              </nav>
            </div>
            <div className="tbl-wrap"><table>
              <thead><tr><th>Project</th><th className="num">Invoices</th><th className="num">Invoiced (net)</th><th className="num">Paid</th><th className="num">Outstanding</th><th className="num">Diary days 2026</th><th className="num">£ per day</th></tr></thead>
              <tbody>
                {rows.map(([id, x]) => {
                  const p = pm.get(id);
                  const d = dm.get(id) ?? 0;
                  return (
                    <tr key={id}>
                      <td><Link href={`/projects/${id}`}><b>{p?.display_name ?? "?"}</b></Link><span className="two">{(p?.clients as unknown as { name: string } | null)?.name}</span></td>
                      <td className="num">{x.n}</td>
                      <td className="num">{gbp(x.net)}</td>
                      <td className="num">{gbp(x.paid)}</td>
                      <td className={`num ${x.out ? "neg" : ""}`}>{x.out ? gbp(x.out) : "—"}</td>
                      <td className="num">{d || "—"}</td>
                      <td className="num">{d ? gbp(x.net / d) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            <p className="small muted">£ per day uses diary days from January 2026 (the 2026 diary), so December 2025 invoices make it a little high for projects that ran then. Paid and outstanding include VAT; invoiced is ex VAT.</p>
          </section>
        </>
      )}
    </>
  );
}
