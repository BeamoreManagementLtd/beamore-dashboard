"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";

const done = () => { revalidatePath("/workwear"); revalidatePath("/portal/workwear"); };

/** Lets a person order (once) on their portal, or stops them. */
export async function setWorkwearAllowed(form: FormData) {
  await requireProfile();
  const id = String(form.get("clerk") ?? "");
  if (!id) return;
  await createServiceClient().from("clerks").update({ workwear_allowed: form.get("on") === "1" }).eq("id", id);
  done();
}

/** Every order waiting to go to the supplier is now with them (once the AVM order has been placed). */
export async function markAllOrdered() {
  await requireProfile();
  await createServiceClient().from("workwear_orders").update({ status: "ordered", ordered_at: new Date().toISOString() }).eq("status", "requested");
  done();
}

export async function setOrderStatus(form: FormData) {
  await requireProfile();
  const id = String(form.get("order") ?? ""), status = String(form.get("status") ?? "");
  if (!id || !["requested", "ordered", "delivered", "cancelled"].includes(status)) return;
  const now = new Date().toISOString();
  await createServiceClient().from("workwear_orders").update({ status, ...(status === "ordered" ? { ordered_at: now } : {}), ...(status === "delivered" ? { delivered_at: now } : {}) }).eq("id", id);
  done();
}

/** An item on or off the order form (it stays in people's history either way). */
export async function setItemActive(form: FormData) {
  await requireProfile();
  const id = String(form.get("item") ?? "");
  if (!id) return;
  await createServiceClient().from("workwear_items").update({ active: form.get("on") === "1" }).eq("id", id);
  done();
}
