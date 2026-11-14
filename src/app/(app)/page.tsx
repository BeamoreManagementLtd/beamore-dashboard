import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { gbp, fd, today } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const me = await requireProfile();
  const { denied } = await searchParams;
  const db = await createClient();
  const t = today();

  const [{ data: overdue }, { data: queue }, { data: tasks }, { data: snap }, { data: lastSync }] = await Promise.all([
    db.from("invoices").select("number,amount_due,due,chase_state(status)").gt("amount_due", 0).lt("due", t),
    db.from("report_queue").select("due,checker"),
    db.from("tasks").select("title,due,link,kind").eq("owner_id", me.id).is("done_at", null).order("due").limit(8),
    // RLS returns nothing here for admin accounts
    db.from("finance_snapshots").select("*").eq("period", "latest").order("taken_at", { ascending: false }).limit(1),
    db.from("sync_runs").select("source,finished_at,ok").order("finished_at", { ascending: false }).limit(6),
  ]);

  const od = overdue ?? [];
  const odTotal = od.reduce((s, i) => s + Number(i.amount_due ?? 0), 0);
  const notChased = od.filter((i) => {
    const cs = i.chase_state as unknown as { status: string } | { status: string }[] | null;
    const st = Array.isArray(cs) ? cs[0]?.status : cs?.status;
    return !st || st === "new";
  }).length;
  const q = queue ?? [];
  const qLate = q.filter((r) => r.due && r.due < t).length;
  const f = snap?.[0];

  return (
    <>
      <div className="head">
        <div>
          <h1>Good morning, {me.full_name?.split(" ")[0] ?? "there"}</h1>
          <p>{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
        </div>
        <span className="small muted">{lastSync?.length ? `Last sync ${fd(lastSync[0].finished_at)}` : "No sync has run yet"}</span>
      </div>
      {denied && <p className="callout warn">That page is for the director only.</p>}

      {me.role === "director" && f && (
        <div className="tiles">
          <div className="tile r"><span className="label">Cash at bank</span><span className="big">{gbp(f.cash)}</span></div>
          <div className="tile r"><span className="label">Fees invoiced (month)</span><span className="big">{gbp(f.sales)}</span></div>
          <div className="tile r"><span className="label">Gross profit (month)</span><span className="big">{gbp((f.sales ?? 0) - (f.subcontractors ?? 0) - (f.cogs ?? 0))}</span></div>
          <div className="tile r"><span className="label">Owed to Beamore</span><span className="big">{gbp(f.receivables)}</span><span className="sub">{gbp(f.receivables_overdue)} overdue</span></div>
        </div>
      )}

      <div className="tiles">
        <Link className={`tile ${od.length ? "alert" : ""}`} href="/invoices">
          <span className="label">Overdue client invoices</span>
          <span className="big">{od.length} · {gbp(odTotal)}</span>
          <span className="sub">{notChased} not chased yet</span>
        </Link>
        <Link className={`tile ${qLate ? "alert" : ""}`} href="/reports">
          <span className="label">Reports waiting to check</span>
          <span className="big">{q.length}</span>
          <span className="sub">{qLate} past due · {q.filter((r) => r.checker === "Unknown").length} with no checker</span>
        </Link>
      </div>

      <section className="panel">
        <h2>Your next actions</h2>
        {tasks?.length ? (
          <table><tbody>
            {tasks.map((x, i) => (
              <tr key={i}><td>{x.link ? <Link href={x.link}>{x.title}</Link> : x.title}<span className="two">{x.kind}</span></td>
                <td className={`num ${x.due && x.due < t ? "neg" : ""}`}>{fd(x.due)}</td></tr>
            ))}
          </tbody></table>
        ) : <p className="empty">Nothing due.</p>}
      </section>
    </>
  );
}
