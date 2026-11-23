"use client";
import { useEffect, useRef, useState } from "react";

/**
 * A wide table with a left-right scroll bar above it as well as below (Ronan, 23 Nov 2026: "I still can't see a
 * horizontal scroll bar": the one under a long table is off the bottom of the screen). The two bars move together.
 */
export function HScroll({ children }: { children: React.ReactNode }) {
  const top = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0), [wide, setWide] = useState(false);
  useEffect(() => {
    const b = body.current;
    if (!b) return;
    const measure = () => { setW(b.scrollWidth); setWide(b.scrollWidth > b.clientWidth + 2); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    if (b.firstElementChild) ro.observe(b.firstElementChild);
    return () => ro.disconnect();
  }, []);
  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => { if (from && to && to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft; };
  return (
    <>
      <div ref={top} className="hscroll-top" style={{ display: wide ? "block" : "none" }} onScroll={() => sync(top.current, body.current)} aria-hidden>
        <div style={{ width: w, height: 1 }} />
      </div>
      <div ref={body} className="tbl-wrap scroll" onScroll={() => sync(body.current, top.current)}>{children}</div>
    </>
  );
}
