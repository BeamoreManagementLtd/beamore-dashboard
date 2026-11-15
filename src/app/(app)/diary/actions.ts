"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { addHoliday, span } from "@/lib/holidays";

const s = (f: FormData, k: string) => { const v = String(f.get(k) ?? "").trim(); return v || null; };
const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A holiday added on the Diary screen, by hand or from a clerk's email: saved, into the diary, cover to-do made. */
export async function saveHoliday(form: FormData) {
  const me = await requireProfile();
  const clerkId = s(form, "clerk_id"), from = s(form, "date_from"), to = s(form, "date_to") ?? from;
  const week = s(form, "week") ?? "";
  if (!clerkId || !isDate(from) || !isDate(to) || to < from) redirect(`/diary?week=${week}&error=${encodeURIComponent("Pick the clerk and the first and last day (last day not before the first)")}`);
  const part = s(form, "part_day");
  let msg: string;
  try {
    const r = await addHoliday(createServiceClient(), {
      clerkId, from, to, partDay: part === "am" || part === "pm" ? part : null, kind: s(form, "kind") ?? "Holiday",
      provisional: form.get("provisional") === "on", coverFor: s(form, "cover_for"), requestId: s(form, "request_id") ?? undefined, by: me.full_name ?? me.email,
    });
    msg = `Holiday ${span(from, to)} saved. Diary: ${r.diary.state === "written" ? r.diary.note : r.diary.state === "waiting" ? "will be written in the next few minutes (the diary was busy)" : r.diary.note}. To-do made: ${r.task.title}`;
  } catch (e) {
    redirect(`/diary?week=${week}&error=${encodeURIComponent(e instanceof Error ? e.message : "Couldn't save")}`);
  }
  revalidatePath("/due");
  redirect(`/diary?week=${from.slice(0, 10)}&done=${encodeURIComponent(msg)}`);
}

/** A holiday email that isn't one (or is already dealt with). */
export async function dismissHolidayEmail(id: string) {
  const me = await requireProfile();
  await createServiceClient().from("holiday_requests").update({ status: "dismissed", decided_by: me.full_name ?? me.email, decided_at: new Date().toISOString() }).eq("id", id);
  revalidatePath("/diary");
}
