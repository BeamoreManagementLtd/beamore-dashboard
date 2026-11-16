"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";

export async function addTask(form: FormData) {
  const me = await requireProfile();
  const title = String(form.get("title") ?? "").trim();
  if (!title) return;
  const db = await createClient();
  const owner = String(form.get("owner_id") ?? "");
  const { error } = await db.from("tasks").insert({
    title, due: String(form.get("due") ?? "") || null, owner_id: owner === "" ? me.id : owner === "none" || owner.startsWith("name:") ? null : owner,
    owner_name: owner.startsWith("name:") ? owner.slice(5) : null, kind: "Added by " + (me.full_name ?? me.email).split(" ")[0],
  });
  if (error) throw new Error(error.message);
  revalidatePath("/due");
  revalidatePath("/");
}

/**
 * Moves a due-list item to someone else (Ronan, 16 Nov 2026). A task someone added changes its owner; an item the
 * dashboard works out for itself keeps the move by its key, so it stays moved each time the list is built.
 * to: a profile id, "name:<first name>" (staff not signed in yet), or "joint" (Ronan or Judy).
 */
export async function moveDueItem(key: string, taskId: string | null, form: FormData) {
  const me = await requireProfile();
  const to = String(form.get("to") ?? "");
  if (!to) return;
  const db = await createClient();
  const { data: dir } = await db.from("profiles").select("full_name").eq("role", "director").limit(1);
  const owner = to === "joint" ? { owner_id: null, owner_name: `${(dir?.[0]?.full_name ?? "Ronan").split(" ")[0]} or Judy` }
    : to.startsWith("name:") ? { owner_id: null, owner_name: to.slice(5) } : { owner_id: to, owner_name: null };
  const { error } = taskId
    ? await db.from("tasks").update(owner).eq("id", taskId)
    : await db.from("due_owner_overrides").upsert({ due_key: key, ...owner, set_by: me.id, set_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  // a card from Ronan's Todoist board moves to the new person's column at the next sync, so the board agrees
  if (taskId) {
    const { data: t } = await db.from("tasks").select("todoist_id").eq("id", taskId).maybeSingle();
    if (t?.todoist_id) await createServiceClient().from("portal_audit").insert({ actor: me.id, action: "todoist-move-wanted", detail: { ask: `${taskId}:${Date.now()}`, task: taskId } });
  }
  revalidatePath("/due");
  revalidatePath("/");
}

export async function completeTask(id: string) {
  await requireProfile();
  const db = await createClient();
  await db.from("tasks").update({ done_at: new Date().toISOString() }).eq("id", id);
  revalidatePath("/due");
  revalidatePath("/");
}
