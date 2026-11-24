"use server";
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { orderProblems, type OrderLine, type WorkwearItem, type WorkwearVariant } from "@/lib/workwear";

/** A clerk's workwear order (Ronan, 24 Nov 2026): only while they're switched on; ordering switches them off again. */
export async function placeWorkwearOrder(a: { name: string; contact: string; address: string; days: number; notes: string; lines: OrderLine[]; none?: boolean }) {
  const me = await requirePortalUser();
  if (!me.clerk) return { ok: false as const, message: "Only clerks can order workwear here." };
  if (me.viewingAs) return { ok: false as const, message: "You're viewing as this clerk, so ordering is switched off." };
  const admin = createServiceClient();
  const { data: c } = await admin.from("clerks").select("workwear_allowed").eq("id", me.clerk.id).single();
  if (!c?.workwear_allowed) return { ok: false as const, message: "Ordering isn't open for you at the moment. Please ask the office." };
  const days = Math.max(1, Math.min(5, Math.round(Number(a.days) || 0)));
  if (!a.name.trim() || !a.address.trim()) return { ok: false as const, message: "Please give your name and a delivery address." };
  const [{ data: items }, { data: variants }] = await Promise.all([
    admin.from("workwear_items").select("*"),
    admin.from("workwear_variants").select("*"),
  ]);
  const lines = (a.lines ?? []).map((l) => ({ item_id: String(l.item_id), colour: String(l.colour), size: String(l.size), quantity: Math.round(Number(l.quantity) || 0) }));
  // "I do not want to order any workwear": recorded (so the office knows), with nothing to order
  const problems = a.none ? [] : orderProblems(lines, (items ?? []) as WorkwearItem[], (variants ?? []) as WorkwearVariant[], days);
  if (problems.length) return { ok: false as const, message: problems.join(". ") };
  const { data: o, error } = await admin.from("workwear_orders").insert({
    clerk_id: me.clerk.id, name: a.name.trim().slice(0, 120), contact: a.contact.trim().slice(0, 200) || me.clerk.email, address: a.address.trim().slice(0, 500),
    days_per_week: days, notes: a.notes.trim().slice(0, 1000) || null, status: a.none ? "delivered" : "requested", source: "portal",
  }).select("id").single();
  if (error || !o) return { ok: false as const, message: "Couldn't place the order. Please try again." };
  if (!a.none) await admin.from("workwear_order_lines").insert(lines.map((l) => {
    const it = (items ?? []).find((i) => i.id === l.item_id)!;
    const v = (variants ?? []).find((x) => x.item_id === l.item_id && x.colour === l.colour && x.size === l.size);
    return { order_id: o.id, item_id: l.item_id, item_name: it.name, supplier_code: v?.supplier_code ?? it.supplier_code, colour: l.colour, size: l.size, quantity: l.quantity };
  }));
  // one order each time ordering is switched on
  await admin.from("clerks").update({ workwear_allowed: false }).eq("id", me.clerk.id);
  revalidatePath("/portal/workwear");
  return { ok: true as const };
}

