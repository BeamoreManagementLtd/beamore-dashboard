import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { AI_MODEL } from "@/lib/portal/read-document";
import { writeHolidayToDiary } from "@/lib/portal/diary-writer";

/**
 * Clerks' holidays (Ronan, 15 Nov 2026): "when someone sends an email about holidays, we need to be able to put the
 * holiday in to the diary and then put a to-do list to get cover for that person's holidays".
 *  1. findHolidayEmails: every 15 minutes, emails from clerks in Ronan's inbox that mention holidays/leave are read by
 *     the AI for the dates, and listed on the Diary screen to add or dismiss (Gmail stays read-only)
 *  2. addHoliday: the holiday is saved, written into the diary's Comments column (writeHolidayToDiary) and a to-do is
 *     made to arrange cover, naming the sites the clerk is down for or usually covers on those days
 */
const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
export const span = (from: string, to: string) => (from === to ? fmt(from) : `${fmt(from)} – ${fmt(to)}`);

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };
const textOf = (pt: Part): string => (pt.mimeType === "text/plain" && pt.body?.data ? Buffer.from(pt.body.data, "base64url").toString("utf8") : (pt.parts ?? []).map(textOf).join("\n"));
const headerOf = (h: { name: string; value: string }[], n: string) => h.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["is_absence", "kind", "date_from", "date_to", "part_day", "note"],
  properties: {
    is_absence: { type: "boolean", description: "The sender is telling us (or asking) that they'll be away / unavailable on particular dates" },
    kind: { type: "string", enum: ["Holiday", "Sick", "Day off"] },
    date_from: { type: ["string", "null"], description: "First day away, YYYY-MM-DD" },
    date_to: { type: ["string", "null"], description: "Last day away, YYYY-MM-DD (same as date_from for one day)" },
    part_day: { type: ["string", "null"], enum: ["am", "pm", null], description: "Only if it's half a day" },
    note: { type: "string", description: "One short line for the office, e.g. 'Asking for 23-27 Nov off, family holiday' or why it isn't a holiday notice" },
  },
};

export async function findHolidayEmails(admin: SupabaseClient) {
  if (!process.env.ANTHROPIC_API_KEY) return 0;
  const { data: clerks } = await admin.from("clerks").select("id,email").eq("active", true).not("email", "is", null);
  const byEmail = new Map((clerks ?? []).filter((c) => c.email).map((c) => [String(c.email).toLowerCase(), c.id as string]));
  if (!byEmail.size) return 0;
  const { data: seen } = await admin.from("holiday_requests").select("gmail_message_id").gte("received_at", new Date(Date.now() - 40 * DAY).toISOString());
  const have = new Set((seen ?? []).map((s) => s.gmail_message_id));
  const g = await driveClient(admin);
  const words = `(holiday OR holidays OR "annual leave" OR leave OR "time off" OR "day off" OR "days off" OR away OR vacation OR unavailable OR "not available" OR sick)`;
  const emails = [...byEmail.keys()];
  let found = 0;
  for (let i = 0; i < emails.length; i += 20) {
    const from = emails.slice(i, i + 20).map((e) => `from:${e}`).join(" OR ");
    const res = await g.gmail<{ messages?: { id: string }[] }>("messages", { q: `newer_than:30d -in:sent ${words} (${from})`, maxResults: "20" });
    for (const m of res.messages ?? []) {
      if (have.has(m.id)) continue;
      have.add(m.id);
      const f = await g.gmail<{ threadId: string; internalDate: string; snippet?: string; payload: Part & { headers: { name: string; value: string }[] } }>(`messages/${m.id}`, { format: "full" });
      const fromHeader = headerOf(f.payload.headers, "From");
      const email = (/<([^>]+)>/.exec(fromHeader)?.[1] ?? fromHeader).trim().toLowerCase();
      const clerkId = byEmail.get(email) ?? null;
      const subject = headerOf(f.payload.headers, "Subject");
      const body = textOf(f.payload).split(/\n(?:From:|On .* wrote:|-----Original Message-----)/)[0].trim().slice(0, 4000) || f.snippet || "";
      const received = new Date(Number(f.internalDate)).toISOString();
      const read = await readHolidayEmail(subject, body, received.slice(0, 10)).catch(() => null);
      const ok = !!read?.is_absence && !!read.date_from;
      await admin.from("holiday_requests").insert({
        clerk_id: clerkId, gmail_message_id: m.id, gmail_thread_id: f.threadId, received_at: received, from_email: email,
        subject: subject.slice(0, 300), excerpt: body.slice(0, 1200),
        date_from: ok ? read!.date_from : null, date_to: ok ? read!.date_to ?? read!.date_from : null,
        part_day: ok ? read!.part_day : null, kind: read?.kind ?? "Holiday", ai_note: read?.note?.slice(0, 300) ?? null,
        // emails that aren't about time off are kept (so they aren't read again) but not shown
        status: ok ? "pending" : "dismissed", decided_by: ok ? null : "AI",
      });
      if (ok) found++;
    }
  }
  return found;
}

async function readHolidayEmail(subject: string, body: string, sent: string) {
  const client = new Anthropic();
  const res = await client.messages.create({
    model: AI_MODEL, max_tokens: 600,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: `An email to Beamore Management from one of its clerks of works, sent ${sent} (UK dates, day/month). Is the clerk telling us they'll be away (holiday, leave, sick, unavailable) on particular dates? If so, give the dates; work out the year from the date sent, and turn days like "next Friday" into dates.\n\nSubject: ${subject}\n\n${body}` }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const t = res.content.find((b) => b.type === "text");
  if (!t || t.type !== "text") return null;
  const r = JSON.parse(t.text) as { is_absence: boolean; kind: string; date_from: string | null; date_to: string | null; part_day: "am" | "pm" | null; note: string };
  const ok = (d: string | null) => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  return { ...r, date_from: ok(r.date_from) ? r.date_from : null, date_to: ok(r.date_to) ? r.date_to : null };
}

/**
 * Saves a holiday, writes it into the diary (or queues it if the diary is busy) and makes the cover to-do.
 * `coverFor` is who arranges cover (a profile id); the to-do goes on their dashboard list (and Todoist).
 */
export async function addHoliday(admin: SupabaseClient, h: {
  clerkId: string; from: string; to: string; partDay: "am" | "pm" | null; kind: string; provisional: boolean; coverFor: string | null; requestId?: string; by: string;
}) {
  const { data: abs, error } = await admin.from("absences").insert({
    clerk_id: h.clerkId, date_from: h.from, date_to: h.to, part_day: h.partDay, kind: h.kind || "Holiday",
    status: h.provisional ? "provisional" : "confirmed", source: "dashboard", diary_state: "waiting",
  }).select("id").single();
  if (error || !abs) throw new Error(error?.message ?? "Couldn't save the holiday");

  // into the diary straight away if it's free; otherwise the 15-minute run tries again
  let diary: { state: string; note: string };
  try { diary = await writeHolidayToDiary(admin, abs.id); }
  catch (e) { diary = { state: "needs_review", note: `Couldn't write to the diary: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` }; }
  await admin.from("absences").update({ diary_state: diary.state === "not_applicable" ? "needs_review" : diary.state, diary_note: diary.note }).eq("id", abs.id);

  const task = await coverTask(admin, abs.id, h);
  if (h.requestId) await admin.from("holiday_requests").update({ status: "added", absence_id: abs.id, decided_by: h.by, decided_at: new Date().toISOString() }).eq("id", h.requestId);
  return { absenceId: abs.id, diary, task };
}

/** The cover to-do: who's away, when, and which sites need someone (planned visits, else where they usually go). */
async function coverTask(admin: SupabaseClient, absenceId: string, h: { clerkId: string; from: string; to: string; partDay: "am" | "pm" | null; coverFor: string | null }) {
  const [{ data: clerk }, { data: planned }, { data: usual }] = await Promise.all([
    admin.from("clerks").select("name").eq("id", h.clerkId).single(),
    admin.from("diary_visits").select("site_as_typed,projects(display_name)").eq("clerk_id", h.clerkId).eq("side", "planned").gte("visit_date", h.from).lte("visit_date", h.to),
    admin.from("diary_visits").select("site_as_typed,visit_date,projects(display_name)").eq("clerk_id", h.clerkId).eq("side", "charged").gte("visit_date", addDays(h.from, -56)).lt("visit_date", h.from),
  ]);
  const names = (rows: { site_as_typed: string; projects: unknown }[]) => {
    const n = new Map<string, number>();
    for (const r of rows) { const s = (r.projects as { display_name?: string } | null)?.display_name ?? r.site_as_typed; n.set(s, (n.get(s) ?? 0) + 1); }
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
  };
  // the weekdays of the holiday, to pick the sites this clerk normally covers on those days
  const weekdays = new Set<number>();
  for (let t = Date.parse(`${h.from}T00:00:00Z`); t <= Date.parse(`${h.to}T00:00:00Z`) && weekdays.size < 7; t += DAY) weekdays.add(new Date(t).getUTCDay());
  const sites = (planned ?? []).length ? names(planned as never) : names(((usual ?? []) as { site_as_typed: string; visit_date: string; projects: unknown }[]).filter((u) => weekdays.has(new Date(`${u.visit_date}T00:00:00Z`).getUTCDay())));
  const t = new Date().toISOString().slice(0, 10);
  const due = addDays(h.from, -7) > t ? addDays(h.from, -7) : t;
  const title = `Arrange cover for ${clerk?.name ?? "clerk"}'s holiday ${span(h.from, h.to)}${h.partDay ? ` (${h.partDay})` : ""}${sites.length ? `: ${sites.slice(0, 5).join(", ")}${sites.length > 5 ? ` and ${sites.length - 5} more` : ""}` : ""}`;
  const { data: owner } = h.coverFor ? { data: { id: h.coverFor } } : await admin.from("profiles").select("id").eq("role", "director").limit(1).maybeSingle();
  const { data: task } = await admin.from("tasks").insert({
    owner_id: owner?.id ?? null, title: title.slice(0, 300), kind: "Holiday cover", due,
    link: `/diary?week=${h.from}&clerk=${h.clerkId}`, source_table: "absences", source_id: absenceId,
  }).select("id").single();
  if (task) await admin.from("absences").update({ cover_task_id: task.id }).eq("id", absenceId);
  return { id: task?.id ?? null, title, sites };
}
