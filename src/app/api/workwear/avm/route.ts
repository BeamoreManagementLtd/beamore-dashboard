import { NextResponse } from "next/server";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** The workwear waiting to be ordered, added up by supplier code, as a spreadsheet (CSV) for the AVM order. */
export async function GET() {
  await requireProfile();
  const { data } = await createServiceClient().from("workwear_orders").select("name,address,workwear_order_lines(item_name,supplier_code,colour,size,quantity)").eq("status", "requested");
  const t = new Map<string, { code: string; item: string; colour: string; size: string; qty: number }>();
  const people: string[][] = [];
  for (const o of data ?? []) for (const l of o.workwear_order_lines as { item_name: string; supplier_code: string | null; colour: string | null; size: string | null; quantity: number }[]) {
    const k = l.supplier_code ?? `${l.item_name}|${l.colour}|${l.size}`;
    const x = t.get(k) ?? { code: l.supplier_code ?? "", item: l.item_name, colour: l.colour ?? "", size: l.size ?? "", qty: 0 };
    x.qty += l.quantity; t.set(k, x);
    people.push([o.name, (o.address ?? "").replace(/\s*\n\s*/g, ", "), l.item_name, l.supplier_code ?? "", l.colour ?? "", l.size ?? "", String(l.quantity)]);
  }
  const csv = (rows: string[][]) => rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const body = [
    csv([["Supplier code", "Item", "Colour", "Size", "Quantity"], ...[...t.values()].sort((a, b) => a.code.localeCompare(b.code)).map((x) => [x.code, x.item, x.colour, x.size, String(x.qty)])]),
    "", "",
    csv([["Person", "Delivery address", "Item", "Supplier code", "Colour", "Size", "Quantity"], ...people]),
  ].join("\r\n");
  return new NextResponse("﻿" + body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="workwear-for-avm-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" } });
}
