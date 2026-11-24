"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SECTIONS, orderProblems, type OrderLine, type WorkwearItem, type WorkwearVariant } from "@/lib/workwear";
import { placeWorkwearOrder } from "./actions";

/** The order form: the same sections and limits as the old Beamore Workwear form. */
export function WorkwearForm({ items, variants, defaults, disabled }: { items: WorkwearItem[]; variants: WorkwearVariant[]; defaults: { name: string; contact: string; address: string }; disabled?: string }) {
  const router = useRouter();
  const [name, setName] = useState(defaults.name), [contact, setContact] = useState(defaults.contact), [address, setAddress] = useState(defaults.address);
  const [days, setDays] = useState(5), [notes, setNotes] = useState("");
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [msg, setMsg] = useState<string | null>(null), [pending, start] = useTransition();
  const problems = useMemo(() => orderProblems(lines, items, variants, days).filter((p) => p !== "Nothing chosen yet"), [lines, items, variants, days]);
  const add = (l: OrderLine) => setLines((ls) => {
    const k = ls.findIndex((x) => x.item_id === l.item_id && x.colour === l.colour && x.size === l.size);
    return k >= 0 ? ls.map((x, j) => (j === k ? { ...x, quantity: x.quantity + l.quantity } : x)) : [...ls, l];
  });
  const name0 = (id: string) => items.find((i) => i.id === id)?.name ?? id;
  const submit = () => {
    setMsg(null);
    start(async () => {
      const r = await placeWorkwearOrder({ name, contact, address, days, notes, lines });
      if (!r.ok) { setMsg(r.message); return; }
      router.push("/portal/workwear?ordered=1");
      router.refresh();
    });
  };
  return (
    <>
      <section className="card">
        <h2>Your details</h2>
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "1 1 220px" }}><label htmlFor="wn">Full name</label><input id="wn" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field" style={{ flex: "1 1 220px" }}><label htmlFor="wc">Email or phone</label><input id="wc" value={contact} onChange={(e) => setContact(e.target.value)} /></div>
          <div className="field" style={{ flex: "0 1 220px" }}><label htmlFor="wd">Days a week you work for Beamore, on average</label>
            <select id="wd" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}</select></div>
        </div>
        <div className="field"><label htmlFor="wa">Delivery address</label><textarea id="wa" rows={3} value={address} onChange={(e) => setAddress(e.target.value)} /></div>
        <p className="small muted">All items are Beamore branded. You can have up to {days} shirt{days === 1 ? "" : "s"} or polo{days === 1 ? "" : "s"}, and one of each of the rest.</p>
      </section>

      {SECTIONS.map((s) => {
        const its = items.filter((i) => s.types.includes(i.type));
        if (!its.length) return null;
        return (
          <section key={s.key} className="card">
            <h2>{s.title}</h2>
            <p className="small muted">{s.note}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 12 }}>
              {its.map((it) => <ItemCard key={it.id} item={it} variants={variants.filter((v) => v.item_id === it.id)} qty={s.limit === "days"} onAdd={add} disabled={!!disabled} />)}
            </div>
          </section>
        );
      })}

      <section className="card">
        <h2>Your order</h2>
        {!lines.length ? <p className="muted">Nothing added yet.</p> : (
          <table className="ptable"><tbody>{lines.map((l, k) => (
            <tr key={k}><td>{l.quantity} × {name0(l.item_id)}, {l.colour}, {l.size}</td>
              <td style={{ textAlign: "right" }}><button className="btn small" onClick={() => setLines((ls) => ls.filter((_, j) => j !== k))}>Remove</button></td></tr>
          ))}</tbody></table>
        )}
        <div className="field" style={{ marginTop: 10 }}><label htmlFor="wo">Anything else (optional)</label><textarea id="wo" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. a size question, or something not on the list" /></div>
        {problems.length > 0 && <p className="callout bad">{problems.join(". ")}</p>}
        {msg && <p className="callout bad">{msg}</p>}
        <button className="btn primary" disabled={!!disabled || pending || !lines.length || problems.length > 0} title={disabled} onClick={submit}>{pending ? "Placing your order…" : "Place order"}</button>
        {disabled && <p className="small muted">{disabled}</p>}
      </section>
    </>
  );
}

function ItemCard({ item, variants, qty, onAdd, disabled }: { item: WorkwearItem; variants: WorkwearVariant[]; qty: boolean; onAdd: (l: OrderLine) => void; disabled: boolean }) {
  const colours = [...new Set(variants.map((v) => v.colour))];
  const [colour, setColour] = useState(colours[0] ?? "");
  const sizes = variants.filter((v) => v.colour === colour).map((v) => v.size);
  const [size, setSize] = useState(sizes[0] ?? "");
  const [n, setN] = useState(1);
  const pic = variants.find((v) => v.colour === colour && v.size === size)?.image_url ?? variants.find((v) => v.colour === colour)?.image_url ?? item.image_url;
  const sizeNow = sizes.includes(size) ? size : sizes[0] ?? "";
  return (
    <div style={{ border: "1px solid var(--line, #ddd)", borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 6 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {pic ? <img src={pic} alt={item.name} style={{ width: "100%", height: 160, objectFit: "contain", background: "#fff", borderRadius: 6 }} /> : <div style={{ height: 160 }} />}
      <b>{item.name}</b>
      <div className="row" style={{ gap: 6 }}>
        <select aria-label="Colour" value={colour} onChange={(e) => { setColour(e.target.value); setSize(""); }} style={{ flex: 1, minWidth: 0 }}>{colours.map((c) => <option key={c}>{c}</option>)}</select>
        <select aria-label="Size" value={sizeNow} onChange={(e) => setSize(e.target.value)} style={{ flex: 1, minWidth: 0 }}>{sizes.map((s) => <option key={s}>{s}</option>)}</select>
        {qty && <input aria-label="Quantity" type="number" min={1} max={5} value={n} onChange={(e) => setN(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} style={{ width: 52 }} />}
      </div>
      <button className="btn small" disabled={disabled || !colour || !sizeNow} onClick={() => onAdd({ item_id: item.id, colour, size: sizeNow, quantity: qty ? n : 1 })}>Add to order</button>
    </div>
  );
}
