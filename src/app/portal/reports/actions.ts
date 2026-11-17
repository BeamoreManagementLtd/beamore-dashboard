"use server";
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";

/** The clerk's own choice to see the AI feedback on their reports (Ronan, 17 Nov 2026): off until they switch it on. */
export async function setAiFeedback(form: FormData) {
  const me = await requirePortalUser();
  if (!me.clerk || me.viewingAs) return;
  await createServiceClient().from("clerks").update({ ai_feedback: form.get("on") === "1", ai_feedback_changed_at: new Date().toISOString() }).eq("id", me.clerk.id);
  revalidatePath("/portal"); revalidatePath("/portal/reports");
}
