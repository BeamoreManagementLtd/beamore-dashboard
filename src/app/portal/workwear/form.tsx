"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { SECTIONS, orderProblems, type OrderLine, type WorkwearItem, type WorkwearVariant } from "@/lib/workwear";
import { placeWorkwearOrder } from "./actions";

/**
 * The order form, laid out like the old Beamore Workwear form (Ronan, 24 Nov 2026: "I like the way it currently looks"):
 * the allowance on the left, then a card per item with its picture, colour, size and quantity, "Add to order", and what's
 * been added for that item; each section can be skipped.
 */
export function WorkwearForm({ items, variants, defaults, disabled }: { items: WorkwearItem[]; variants: WorkwearVariant[]; defaults: { name: string; contact: string; address: string }; disabled?: string }) {
  const router = useRouter();
  const [name, setName] = useState(defaults.name), [contact, setContact] = useState(defaults.contact), [address, setAddress] = useState(defaults.address);
  const [days, setDays] = useState(5), [notes, setNotes] = useState(""), [none, setNone] = useState(false);
  const [skip, setSkip] = useState<Record<string, boolean>>({});
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [msg, setMsg] = useState<string | null>(null), [pending, start] = useTransition();
  const typeOf = (id: string) => items.find((i) => i.id === id)?.type ?? "";
  const inSection = (key: string) => lines.filter((l) => SECTIONS.find((s) => s.key === key)!.types.includes(typeOf(l.item_id)));
  const count = (key: string) => inSection(key).reduce((a, l) => a + l.quantity, 0);
  const shirtsLeft = Math.max(0, days - count("shirts"));
  const problems = useMemo(() => orderProblems(lines, items, variants, days).filter((p) => p !== "Nothing chosen yet"), [lines, items, variants, days]);
  const add = (l: OrderLine) => setLines((ls) => {
    const sec = SECTIONS.find((s) => s.types.includes(typeOf(l.item_id)))!;
    // one-of sections: choosing another replaces the one already chosen
    const rest = sec.limit === 1 ? ls.filter((x) => !sec.types.includes(typeOf(x.item_id))) : ls;
    const k = rest.findIndex((x) => x.item_id === l.item_id && x.colour === l.colour && x.size === l.size);
    return k >= 0 ? rest.map((x, j) => (j === k ? { ...x, quantity: x.quantity + l.quantity } : x)) : [...rest, sec.limit === 1 ? { ...l, quantity: 1 } : l];
  });
  const remove = (l: OrderLine) => setLines((ls) => ls.filter((x) => x !== l));
  const name0 = (id: string) => items.find((i) => i.id === id)?.name ?? id;
  const submit = () => {
    setMsg(null);
    start(async () => {
      const r = await placeWorkwearOrder({ name, contact, address, days, notes: none ? `Doesn't want any workwear${notes ? `. ${notes}` : ""}` : notes, lines: none ? [] : lines, none });
      if (!r.ok) { setMsg(r.message); return; }
      router.push("/portal/workwear?ordered=1");
      router.refresh();
    });
  };
  const chosen = (key: string) => { const n = count(key); return n ? `${n} selected` : skip[key] ? "Not wanted" : "None selected"; };

  return (
    <div className="ww">
      <aside className="ww-side">
        <div className="ww-card">
          <h3>Allowance</h3>
          <div className="ww-big"><b>{days}</b><span>shirts or polos allowed</span></div>
          <p className="ww-left">{none ? "No workwear this time." : shirtsLeft ? `You can choose up to ${shirtsLeft} more shirt or polo item${shirtsLeft === 1 ? "" : "s"}.` : "You've chosen all your shirts and polos."}</p>
          {SECTIONS.filter((s) => s.key !== "shirts").map((s) => <div key={s.key} className="ww-row"><span>{s.title}</span><b>{chosen(s.key)}</b></div>)}
          <a className="ww-btn" href="#ww-review">Review order</a>
          <p className="ww-tiny">All items will be Beamore branded. Your order goes straight to the office.</p>
        </div>
      </aside>

      <div className="ww-main">
        <section className="ww-card">
          <h2>Your details</h2>
          <div className="ww-grid2">
            <label>Full name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Email or phone<input value={contact} onChange={(e) => setContact(e.target.value)} /></label>
            <label>How many days a week on average do you work for Beamore?
              <select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((d) => <option key={d} value={d}>{d} day{d === 1 ? "" : "s"}</option>)}</select></label>
          </div>
          <label>Delivery address<textarea rows={3} value={address} onChange={(e) => setAddress(e.target.value)} /></label>
          <label className="ww-check"><input type="checkbox" checked={none} onChange={(e) => setNone(e.target.checked)} /> I do not want to order any workwear.</label>
        </section>

        {!none && SECTIONS.map((s) => {
          const its = items.filter((i) => s.types.includes(i.type));
          if (!its.length) return null;
          return (
            <section key={s.key} className="ww-card">
              <h2>{s.title}</h2>
              <p className="ww-note">{s.note}</p>
              <button type="button" className={`ww-skip${skip[s.key] ? " on" : ""}`} onClick={() => { setSkip((x) => ({ ...x, [s.key]: !x[s.key] })); if (!skip[s.key]) setLines((ls) => ls.filter((l) => !s.types.includes(typeOf(l.item_id)))); }}>
                {skip[s.key] ? `Not wanted (undo)` : `I do not want ${s.key === "shirts" ? "shirts or polo shirts" : s.key === "vest" ? "a vest" : s.key === "jumper" ? "a sweatshirt or fleece" : s.key === "outerwear" ? "outerwear" : "a hi-vis jacket"}`}
              </button>
              {!skip[s.key] && (
                <div className="ww-items">
                  {its.map((it) => <ItemCard key={it.id} item={it} variants={variants.filter((v) => v.item_id === it.id)} qty={s.limit === "days"} onAdd={add} onRemove={remove}
                    added={lines.filter((l) => l.item_id === it.id)} disabled={!!disabled} />)}
                </div>
              )}
            </section>
          );
        })}

        <section className="ww-card" id="ww-review">
          <h2>Review your order</h2>
          {none ? <p className="ww-note">You&apos;ve said you don&apos;t want any workwear this time.</p> : !lines.length ? <p className="ww-note">Nothing added yet.</p> : (
            <ul className="ww-list">{lines.map((l, k) => <li key={k}>{l.quantity} × {name0(l.item_id)}, {l.colour}, {l.size} <button type="button" onClick={() => remove(l)}>Remove</button></li>)}</ul>
          )}
          <label>Anything else (optional)<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. a size question, or something not on the list" /></label>
          {problems.length > 0 && !none && <p className="ww-err">{problems.join(". ")}</p>}
          {msg && <p className="ww-err">{msg}</p>}
          <button type="button" className="ww-btn" disabled={!!disabled || pending || (!none && (!lines.length || problems.length > 0))} title={disabled} onClick={submit}>{pending ? "Sending…" : none ? "Send" : "Place order"}</button>
          {disabled && <p className="ww-tiny">{disabled}</p>}
        </section>
      </div>
    </div>
  );
}

function ItemCard({ item, variants, qty, onAdd, onRemove, added, disabled }: { item: WorkwearItem; variants: WorkwearVariant[]; qty: boolean; onAdd: (l: OrderLine) => void; onRemove: (l: OrderLine) => void; added: OrderLine[]; disabled: boolean }) {
  const colours = [...new Set(variants.map((v) => v.colour))];
  const [colour, setColour] = useState(colours[0] ?? "");
  const sizes = variants.filter((v) => v.colour === colour).map((v) => v.size).sort(sizeOrder);
  const [size, setSize] = useState(sizes[0] ?? "");
  const [n, setN] = useState(1);
  const sizeNow = sizes.includes(size) ? size : sizes[0] ?? "";
  const v = variants.find((x) => x.colour === colour && x.size === sizeNow);
  const pic = v?.image_url ?? variants.find((x) => x.colour === colour)?.image_url ?? item.image_url;
  return (
    <div className="ww-item">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <div className="ww-pic">{pic ? <img src={pic} alt={item.name} /> : null}</div>
      <b className="ww-name">{item.name}</b>
      <span className="ww-code">{v?.supplier_code ?? item.supplier_code}</span>
      <div className="ww-opts">
        <label>Colour<select value={colour} onChange={(e) => { setColour(e.target.value); setSize(""); }}>{colours.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label>Size<select value={sizeNow} onChange={(e) => setSize(e.target.value)}>{sizes.map((s) => <option key={s}>{s}</option>)}</select></label>
        {qty && <label>Quantity<span className="ww-step"><button type="button" onClick={() => setN(Math.max(1, n - 1))}>-</button><input value={n} readOnly /><button type="button" onClick={() => setN(Math.min(5, n + 1))}>+</button></span></label>}
      </div>
      <button type="button" className="ww-add" disabled={disabled || !colour || !sizeNow} onClick={() => onAdd({ item_id: item.id, colour, size: sizeNow, quantity: qty ? n : 1 })}>Add to order</button>
      <div className="ww-added"><b>Added for this item</b>
        {!added.length ? <span>{qty ? "No colours added yet." : "Not added yet."}</span> : added.map((l, k) => <span key={k}>{l.quantity} × {l.colour}, {l.size} <button type="button" onClick={() => onRemove(l)}>Remove</button></span>)}
      </div>
    </div>
  );
}

// sizes in the order people expect: XS, S, M, L, XL, 2XL... (the "Relaxed" fits after the regular ones); collar sizes by number
const LETTERS = ["XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "4XL", "5XL", "6XL"];
function sizeOrder(a: string, b: string) {
  const key = (s: string) => {
    const relaxed = /relaxed/i.test(s) ? 1 : 0, base = s.replace(/\s*relaxed/i, "").trim().toUpperCase();
    const n = Number(base); if (!Number.isNaN(n)) return [0, n, relaxed];
    const k = LETTERS.indexOf(base); return [1, relaxed * 100 + (k < 0 ? 99 : k), 0];
  };
  const x = key(a), y = key(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
