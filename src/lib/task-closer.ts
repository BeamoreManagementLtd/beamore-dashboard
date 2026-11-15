import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { AI_MODEL, aiConfigured } from "@/lib/portal/read-document";
import { todoistConfigured, todoistCommands } from "@/lib/todoist";

/**
 * Ticks off typed to-dos once they've been done (Ronan, 15 Nov 2026). Every hour, if anything new has happened, the AI
 * compares the open tasks (Ronan's Work list cards, Judy's and Anel's lists, dashboard tasks) with the evidence the
 * dashboard can see since the last check:
 *  - emails Ronan sent and received (sender, recipients, subject, first lines)
 *  - project events (info received, clerk booked, started on site, notes...) and project stage changes
 * Clear evidence: the task is ticked off on the dashboard and in Todoist, with a comment saying why.
 * Fairly sure: a "Looks done?" note is added and the task is left for a person. Nothing is ever sent or deleted.
 */
type Verdict = { task: number; verdict: "done" | "looks_done" | "not_yet"; reason: string };

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["task", "verdict", "reason"],
        properties: {
          task: { type: "integer", description: "the task's number from the list" },
          verdict: { type: "string", enum: ["done", "looks_done", "not_yet"] },
          reason: { type: "string", description: "short, plain English, naming the evidence, e.g. 'You emailed Andy Williamson the schedules on 16 Nov'" },
        },
      },
    },
  },
};

const header = (m: { payload?: { headers?: { name: string; value: string }[] } }, n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";

export async function closeDoneTasks(admin: SupabaseClient, { sinceOverride }: { sinceOverride?: string } = {}) {
  if (!aiConfigured()) return { ok: false, message: "ANTHROPIC_API_KEY isn't set" };
  const { data: last } = await admin.from("sync_runs").select("started_at").eq("source", "task-closer").eq("ok", true).order("started_at", { ascending: false }).limit(1);
  const since = sinceOverride ?? last?.[0]?.started_at ?? new Date(Date.now() - 3 * 864e5).toISOString();
  const sinceDay = since.slice(0, 10);

  // ---- open tasks
  const { data: tasks } = await admin.from("tasks").select("id,title,kind,due,owner_name,owner_id,created_at,todoist_id,ai_note").is("done_at", null).order("created_at");
  if (!tasks?.length) return { ok: true, message: "No open tasks" };

  // ---- evidence since the last check
  const evidence: string[] = [];
  const g = await driveClient(admin);
  const after = Math.floor(Date.parse(since) / 1000);
  for (const [label, q] of [["Sent", `in:sent after:${after}`], ["Received", `in:inbox after:${after} -category:promotions -category:social`]] as const) {
    const list = await g.gmail<{ messages?: { id: string }[] }>("messages", { q, maxResults: "60" });
    for (const m of list.messages ?? []) {
      const full = await g.gmail<{ snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }>(`messages/${m.id}`, { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
      const when = full.internalDate ? new Date(Number(full.internalDate)).toISOString().slice(0, 10) : "";
      evidence.push(`EMAIL ${label} ${when} | from ${header(full, "From")} | to ${header(full, "To")} | ${header(full, "Subject")} | ${(full.snippet ?? "").slice(0, 220)}`);
    }
  }
  const [{ data: events }, { data: projects }] = await Promise.all([
    admin.from("project_events").select("happened_at,kind,who,body,projects(display_name)").gte("happened_at", since).order("happened_at").limit(150),
    admin.from("projects").select("display_name,stage,clerk_status,stage_changed_at").gte("stage_changed_at", since).limit(80),
  ]);
  for (const e of events ?? []) evidence.push(`PROJECT ${e.happened_at.slice(0, 10)} | ${(e.projects as unknown as { display_name: string } | null)?.display_name ?? ""} | ${e.kind}${e.who ? ` (${e.who})` : ""} | ${(e.body ?? "").slice(0, 220)}`);
  for (const p of projects ?? []) evidence.push(`PROJECT STAGE ${String(p.stage_changed_at).slice(0, 10)} | ${p.display_name} | now ${p.stage}${p.clerk_status ? `, clerk ${p.clerk_status}` : ""}`);
  if (!evidence.length) return { ok: true, message: `Nothing new since ${sinceDay}` };

  // ---- ask
  const list = tasks.map((t, i) => `${i + 1}. ${t.title}${t.owner_name ? ` [for ${t.owner_name}]` : ""} (added ${String(t.created_at).slice(0, 10)})`);
  const prompt = `You help a small construction consultancy (Beamore) keep its to-do lists tidy. Below are the open tasks, then what has happened since ${sinceDay} (emails and dashboard updates).

For each task, decide:
- "done" only when the evidence clearly shows THIS task was completed (e.g. the email the task asks for was sent to the right person, or the dashboard shows the thing now happened). Done by anyone counts.
- "looks_done" when the evidence suggests it's probably done but you can't be sure.
- "not_yet" otherwise (this will be most tasks). Don't list not_yet tasks unless something relevant happened.
Be strict: a related email is not proof the task is finished. Never guess.

OPEN TASKS
${list.join("\n")}

WHAT HAPPENED
${evidence.join("\n").slice(0, 60000)}`;
  const client = new Anthropic();
  const res = await client.messages.create({
    model: AI_MODEL, max_tokens: 4000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("The AI returned no answer");
  const verdicts = (JSON.parse(text.text) as { results: Verdict[] }).results;

  // ---- act
  let closed = 0, flagged = 0;
  const notes: { type: string; args: Record<string, unknown> }[] = [];
  for (const v of verdicts) {
    const t = tasks[v.task - 1];
    if (!t || v.verdict === "not_yet") continue;
    if (v.verdict === "done") {
      await admin.from("tasks").update({ done_at: new Date().toISOString(), ai_note: `Ticked off automatically: ${v.reason}` }).eq("id", t.id);
      if (t.todoist_id) notes.push({ type: "note_add", args: { item_id: t.todoist_id, content: `✓ Ticked off by the dashboard: ${v.reason}` } });
      closed++;
    } else if (!t.ai_note) {
      await admin.from("tasks").update({ ai_note: `Looks done? ${v.reason}` }).eq("id", t.id);
      if (t.todoist_id) notes.push({ type: "note_add", args: { item_id: t.todoist_id, content: `Looks done? ${v.reason} (tick it off if so)` } });
      flagged++;
    }
  }
  if (notes.length && todoistConfigured()) await todoistCommands(notes).catch(() => undefined); // the Todoist sync ticks the cards themselves
  await admin.from("portal_audit").insert({ actor: "AI", action: "task-closer", detail: { since, evidence: evidence.length, verdicts } });
  return { ok: true, message: `${evidence.length} new emails/updates checked against ${tasks.length} open tasks: ${closed} ticked off, ${flagged} flagged "looks done?"` };
}
