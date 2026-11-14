"use server";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export async function addTask(form: FormData) {
  const me = await requireProfile();
  const title = String(form.get("title") ?? "").trim();
  if (!title) return;
  const db = await createClient();
  const owner = String(form.get("owner_id") ?? "");
  const { error } = await db.from("tasks").insert({
    title, due: String(form.get("due") ?? "") || null, owner_id: owner === "" ? me.id : owner === "none" ? null : owner, kind: "Added by " + (me.full_name ?? me.email).split(" ")[0],
  });
  if (error) throw new Error(error.message);
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
