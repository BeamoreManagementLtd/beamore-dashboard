import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { fd } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/workwear";
import { setWorkwearAllowed, markAllOrdered, setOrderStatus, setItemActive } from "./actions";

export const dynamic = "force-dynamic";

type Line = { item_name: string; supplier_code: string | null; colour: string | null; size: string | null; quantity: number };

/**
 * Workwear (Ronan, 24 Nov 2026): who may order on their portal, what's waiting to be ordered from AVM (added up by
 * supplier code, with a download), every order and its status, and the items on the form.
 */
export default async function WorkwearAdmin({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requireProfile();
  const { tab = "to-order" } = await searchParams;
  const db = createServiceClient();
  const [{ data: orders }, { data: clerks }, { data: items }] = await Promise.all([
    db.from("workwear_orders").select("id,clerk_id,name,address,contact,days_per_week,notes,status,source,created_at,workwear_order_lines(item_name,supplier_code,colour,size,quantity)").order("created_at", { ascending: false }).limit(500),
    db.from("clerks").select("id,name,active,portal_access,workwear_allowed").eq("active", true).order("name"),
    db.from("workwear_items").select("id,type,name,active,sort").order("sort"),
  ]);
  const waiting = (orders ?? []).filter((o) => o.status === "requested");
  const totals = new Map<string, Line>();
  for (const o of waiting) for (const l of o.workwear_order_lines as Line[]) {
    const k = l.supplier_code ?? `${l.item_name}|${l.colour}|${l.size}`;
    const t = totals.get(k); totals.set(k, t ? { ...t, quantity: t.quantity + l.quantity } : { ...l });
  }
  const lastOrder = (id: string) => (orders ?? []).find((o) => o.clerk_id === id && o.status !== "cancelled")?.created_at ?? null;
  const TABS: [string, string][] = [["to-order", `To order from AVM${waiting.length ? ` (${waiting.length})` : ""}`], ["people", "Who can order"], ["orders", "All orders"], ["items", "Items on the form"]];
  const lines = (o: { workwear_order_lines: unknown }) => (o.workwear_order_lines as Line[]).map((l, i) => <div key={i}>{l.quantity} × {l.item_name}{l.colour ? `, ${l.colour}` : ""}{l.size ? `, ${l.size}` : ""}</div>);

  return (
    <>
      <div className="head"><div><h1>Workwear</h1><p>Clerks order Beamore-branded workwear on their portal when you switch it on for them (one order each time). Orders wait here until they&apos;ve been ordered from AVM.</p></div></div>
      <p className="row" style={{ gap: 6 }}>{TABS.map(([k, label]) => <Link key={k} className={`btn${tab === k ? " primary" : ""}`} href={`/workwear?tab=${k}`}>{label}</Link>)}</p>

      {tab === "to-order" && (
        <>
          <section className="panel">
            <h2>Totals for the AVM order</h2>
            {!totals.size ? <p className="empty">Nothing waiting to be ordered.</p> : (
              <>
                <table><thead><tr><th>Supplier code</th><th>Item</th><th>Colour</th><th>Size</th><th className="num">Quantity</th></tr></thead>
                  <tbody>{[...totals.values()].sort((a, b) => (a.supplier_code ?? "").localeCompare(b.supplier_code ?? "")).map((l) => (
                    <tr key={l.supplier_code ?? l.item_name + l.colour + l.size}><td className="small">{l.supplier_code}</td><td>{l.item_name}</td><td>{l.colour}</td><td>{l.size}</td><td className="num"><b>{l.quantity}</b></td></tr>
                  ))}</tbody></table>
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <a className="btn" href="/api/workwear/avm">Download for AVM (spreadsheet)</a>
                  <form action={markAllOrdered}><button className="btn primary" title="Once you've placed the order with AVM: these orders move to 'With the supplier'">Mark all as ordered from AVM</button></form>
                </div>
              </>
            )}
          </section>
          {!!waiting.length && (
            <section className="panel">
              <h2>Orders waiting <span className="small muted">{waiting.length}</span></h2>
              <table><thead><tr><th>Ordered</th><th>Who</th><th>Deliver to</th><th>Items</th></tr></thead>
                <tbody>{waiting.map((o) => (
                  <tr key={o.id}><td className="small">{fd(o.created_at)}</td><td>{o.name}<span className="two small muted">{o.contact}</span></td>
                    <td className="small" style={{ whiteSpace: "pre-line" }}>{o.address}</td><td className="small">{lines(o)}{o.notes && <span className="two muted">Note: {o.notes}</span>}</td></tr>
                ))}</tbody></table>
            </section>
          )}
        </>
      )}

      {tab === "people" && (
        <section className="panel">
          <h2>Who can order</h2>
          <p className="small muted">Switch someone on and the order form appears on their portal&apos;s Workwear page. Once they order, it switches itself off.</p>
          <table><thead><tr><th>Clerk</th><th>Last order</th><th>Ordering</th></tr></thead>
            <tbody>{(clerks ?? []).map((c) => (
              <tr key={c.id}><td>{c.name}{!c.portal_access && <span className="two small muted">no portal access yet</span>}</td>
                <td className="small">{lastOrder(c.id) ? fd(lastOrder(c.id)) : <span className="muted">never</span>}</td>
                <td><form action={setWorkwearAllowed}><input type="hidden" name="clerk" value={c.id} /><input type="hidden" name="on" value={c.workwear_allowed ? "0" : "1"} />
                  <button className={`btn small${c.workwear_allowed ? " primary" : ""}`}>{c.workwear_allowed ? "On: can order (switch off)" : "Off (switch on)"}</button></form></td></tr>
            ))}</tbody></table>
        </section>
      )}

      {tab === "orders" && (
        <section className="panel">
          <h2>All orders</h2>
          <table><thead><tr><th>Ordered</th><th>Who</th><th>Items</th><th>Status</th></tr></thead>
            <tbody>{(orders ?? []).map((o) => (
              <tr key={o.id}><td className="small">{fd(o.created_at)}{o.source === "old_form" && <span className="two muted">old form</span>}</td><td>{o.name}</td><td className="small">{lines(o)}</td>
                <td><form action={setOrderStatus} className="row" style={{ gap: 4 }}><input type="hidden" name="order" value={o.id} />
                  <select name="status" defaultValue={o.status}>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <button className="btn small">Save</button></form></td></tr>
            ))}</tbody></table>
        </section>
      )}

      {tab === "items" && (
        <section className="panel">
          <h2>Items on the form</h2>
          <p className="small muted">Switch an item off to take it off the order form (it stays in people&apos;s history).</p>
          <table><tbody>{(items ?? []).map((i) => (
            <tr key={i.id}><td>{i.name}<span className="two small muted">{i.type} · {i.id.toUpperCase()}</span></td>
              <td><form action={setItemActive}><input type="hidden" name="item" value={i.id} /><input type="hidden" name="on" value={i.active ? "0" : "1"} />
                <button className={`btn small${i.active ? " primary" : ""}`}>{i.active ? "On the form (take off)" : "Off (put on)"}</button></form></td></tr>
          ))}</tbody></table>
        </section>
      )}
    </>
  );
}
