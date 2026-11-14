"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

const STATUSES = ["new", "our_move", "queried", "promised", "waiting"];

/** Save where a chase stands. Changes to the next action or promised date are written to the timeline. */
export async function saveChaseState(invoiceId: string, number: string, form: FormData) {
  const me = await requireProfile();
  const db = await createClient();
  const status = String(form.get("status"));
  if (!STATUSES.includes(status)) throw new Error("Unknown status");
  const next = {
    status,
    with_whom: String(form.get("with_whom") ?? "") || null,
    next_action: String(form.get("next_action") ?? "").trim() || null,
    next_action_due: String(form.get("next_action_due") ?? "") || null,
    promised_date: String(form.get("promised_date") ?? "") || null,
    owner_id: String(form.get("owner_id") ?? "") || null,
    updated_at: new Date().toISOString(),
  };
  const { data: before } = await db.from("chase_state").select("*").eq("invoice_id", invoiceId).maybeSingle();
  const { error } = await db.from("chase_state").upsert({ invoice_id: invoiceId, ...next });
  if (error) throw new Error(error.message);

  const events = [];
  if (before?.next_action !== next.next_action || before?.next_action_due !== next.next_action_due)
    events.push({ kind: "Next action changed", body: `${next.next_action ?? "(none)"}${next.next_action_due ? ` · due ${next.next_action_due}` : ""}` });
  if (before?.promised_date !== next.promised_date)
    events.push({ kind: "Promised date changed", body: next.promised_date ? `Promised payment date ${next.promised_date}` : "Promised date cleared" });
  if (events.length)
    await db.from("chase_events").insert(events.map((e) => ({
      ...e, invoice_id: invoiceId, happened_at: new Date().toISOString(), source: "team", who: me.full_name ?? me.email, created_by: me.id,
    })));
  revalidatePath(`/invoices/${encodeURIComponent(number)}`);
  revalidatePath("/invoices");
}

/** Log a call, email or note against an invoice. */
export async function addChaseEvent(invoiceId: string, number: string, form: FormData) {
  const me = await requireProfile();
  const db = await createClient();
  const kind = String(form.get("kind"));
  const body = String(form.get("body") ?? "").trim();
  if (!body || !["Phone call", "Email sent", "Note"].includes(kind)) return;
  await db.from("chase_events").insert({
    invoice_id: invoiceId, happened_at: new Date().toISOString(), source: "team", kind, body, who: me.full_name ?? me.email, created_by: me.id,
  });
  // A call or email moves an invoice that hadn't been chased yet to "waiting on them"; other statuses are left alone
  if (kind !== "Note") {
    const { data: cur } = await db.from("chase_state").select("status").eq("invoice_id", invoiceId).maybeSingle();
    if (!cur) await db.from("chase_state").insert({ invoice_id: invoiceId, status: "waiting", with_whom: "Client" });
    else if (cur.status === "new") await db.from("chase_state").update({ status: "waiting", with_whom: "Client", updated_at: new Date().toISOString() }).eq("invoice_id", invoiceId);
  }
  revalidatePath(`/invoices/${encodeURIComponent(number)}`);
  revalidatePath("/invoices");
}
