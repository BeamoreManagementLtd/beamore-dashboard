"use server";
import { redirect } from "next/navigation";
import { requireDirector } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { londonInstant } from "@/lib/invoice-deadline";

/** Ronan sets the date (and time) clerks' invoices for a month are due by. */
export async function setDeadline(form: FormData) {
  const me = await requireDirector();
  const month = String(form.get("month") ?? ""), date = String(form.get("date") ?? ""), time = String(form.get("time") ?? "17:00");
  if (!/^\d{4}-\d{2}$/.test(month) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) redirect("/invoice-deadline?error=1");
  const dueAt = londonInstant(date, time);
  await createServiceClient().from("portal_audit").insert({ actor: me.email, action: "invoice-deadline", detail: { month, due_at: dueAt } });
  redirect(`/invoice-deadline?saved=${month}`);
}
