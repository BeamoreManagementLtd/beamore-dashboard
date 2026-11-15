"use server";
import { revalidatePath } from "next/cache";
import { requireProfile, requireDirector } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { askDashboard, run, type Turn } from "@/lib/ask";

/** One question (or job) for the dashboard's assistant, with the asker's own permissions. */
export async function ask(history: Turn[], question: string) {
  const me = await requireProfile();
  const q = question.trim().slice(0, 2000);
  if (!q) return { ok: false as const, text: "Type a question first." };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false as const, text: "The AI isn't switched on (no ANTHROPIC_API_KEY)." };
  try {
    const text = await askDashboard(await createClient(), me, history, q);
    revalidatePath("/ask");
    return { ok: true as const, text };
  } catch (e) {
    return { ok: false as const, text: `Sorry, that didn't work: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` };
  }
}

/** Ronan approves a request from the pop-up: the action is carried out, or the question answered, for the person who asked. */
export async function approveRequest(fd: FormData) {
  const ronan = await requireDirector();
  const db = await createClient();
  const { data: r } = await db.from("ai_requests").select("*").eq("id", String(fd.get("id"))).eq("status", "pending").maybeSingle();
  if (!r) return;
  const asThem = { ...ronan, full_name: r.requester_name ?? ronan.full_name }; // shows who asked on notes and tasks
  let answer: string;
  try {
    if (r.kind === "action" && r.payload?.tool) {
      const out = (await run(db, asThem, r.payload.tool, r.payload.input ?? {})) as { done?: string; error?: string };
      answer = out.done ?? out.error ?? "Done";
    } else {
      answer = await askDashboard(db, { ...asThem, role: "admin" }, [], r.question ?? r.summary, { approvedOffTopic: r.kind === "off_topic", noLimit: true });
    }
  } catch (e) {
    answer = `Approved, but it didn't work: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`;
  }
  await db.from("ai_requests").update({ status: "approved", decided_at: new Date().toISOString(), answer }).eq("id", r.id);
  revalidatePath("/", "layout");
}

export async function denyRequest(fd: FormData) {
  await requireDirector();
  const db = await createClient();
  await db.from("ai_requests").update({ status: "denied", decided_at: new Date().toISOString() }).eq("id", String(fd.get("id"))).eq("status", "pending");
  revalidatePath("/", "layout");
}
