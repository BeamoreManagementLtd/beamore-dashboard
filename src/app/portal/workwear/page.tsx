import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { fmtDate } from "@/lib/portal/data";
import { STATUS_LABEL, type WorkwearItem, type WorkwearVariant } from "@/lib/workwear";
import { WorkwearForm } from "./form";

export const dynamic = "force-dynamic";

/** Workwear (Ronan, 24 Nov 2026): order Beamore-branded workwear when the office has switched it on, and see past orders. */
export default async function Workwear({ searchParams }: { searchParams: Promise<{ ordered?: string }> }) {
  const me = await requirePortalUser();
  if (!me.clerk) return <section className="card"><h1>Workwear</h1><p className="muted">Clerks order their workwear here.</p></section>;
  const { ordered } = await searchParams;
  const db = createServiceClient();
  const [{ data: c }, { data: k }, { data: items }, { data: variants }, { data: orders }] = await Promise.all([
    db.from("clerks").select("name,email,phone,workwear_allowed").eq("id", me.clerk.id).single(),
    db.from("clerk_compliance").select("address").eq("clerk_id", me.clerk.id).maybeSingle(),
    db.from("workwear_items").select("*").eq("active", true).order("sort"),
    db.from("workwear_variants").select("*").eq("active", true).order("sort"),
    db.from("workwear_orders").select("id,created_at,status,days_per_week,address,source,workwear_order_lines(item_name,colour,size,quantity)").eq("clerk_id", me.clerk.id).neq("status", "cancelled").order("created_at", { ascending: false }),
  ]);
  return (
    <>
      <h1>Workwear</h1>
      {ordered && <p className="callout good">Thanks, your order is in. The office will order it from the supplier and it&apos;ll come to the address you gave.</p>}
      {c?.workwear_allowed ? (
        <WorkwearForm
          items={(items ?? []) as WorkwearItem[]} variants={(variants ?? []) as WorkwearVariant[]}
          defaults={{ name: c.name ?? "", contact: c.phone || c.email || "", address: k?.address ?? "" }}
          disabled={me.viewingAs ? "You're viewing as this clerk, so ordering is switched off." : undefined}
        />
      ) : (
        <section className="card"><p className="muted">Ordering workwear isn&apos;t open for you at the moment. When you&apos;re due some, the office will switch it on and the order form will appear here.</p></section>
      )}
      <section className="card">
        <h2>What you&apos;ve ordered</h2>
        {!orders?.length ? <p className="muted">Nothing yet.</p> : (
          <table className="ptable">
            <thead><tr><th>Ordered</th><th>Items</th><th>Status</th></tr></thead>
            <tbody>{orders.map((o) => (
              <tr key={o.id}>
                <td style={{ whiteSpace: "nowrap" }}>{fmtDate(o.created_at)}</td>
                <td className="small">{(o.workwear_order_lines as { item_name: string; colour: string | null; size: string | null; quantity: number }[]).map((l, i) => <div key={i}>{l.quantity} × {l.item_name}{l.colour ? `, ${l.colour}` : ""}{l.size ? `, ${l.size}` : ""}</div>)}</td>
                <td className="small">{o.source === "old_form" && o.status === "ordered" ? "Ordered" : STATUS_LABEL[o.status] ?? o.status}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </>
  );
}
