"use server";
import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";

/** The clerk's own choice to see the AI feedback on their reports (Ronan, 17 Nov 2026): off until they switch it on. */
export async function setAiFeedback(form: FormData) {
  const me = await requirePortalUser();
  if (!me.clerk || me.viewingAs) return;
  const on = form.get("on") === "1";
  // switching the feedback off switches the emails off too; switching it on leaves the emails off until they choose them
  await createServiceClient().from("clerks").update({ ai_feedback: on, ...(on ? {} : { ai_feedback_email: false }), ai_feedback_changed_at: new Date().toISOString() }).eq("id", me.clerk.id);
  revalidatePath("/portal"); revalidatePath("/portal/reports");
}

/** The emails are a separate choice (Ronan, 17 Nov 2026): only for a clerk who has the feedback switched on. */
export async function setAiFeedbackEmail(form: FormData) {
  const me = await requirePortalUser();
  if (!me.clerk || me.viewingAs) return;
  await createServiceClient().from("clerks").update({ ai_feedback_email: form.get("on") === "1", ai_feedback_changed_at: new Date().toISOString() }).eq("id", me.clerk.id).eq("ai_feedback", true);
  revalidatePath("/portal"); revalidatePath("/portal/reports");
}
