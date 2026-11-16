import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDueList } from "@/lib/due";
import type { Profile } from "@/lib/auth";
import { staffPeople, type StaffPerson } from "@/lib/staff";

/**
 * Two-way link with Ronan's Todoist "Work list" board (Todoist API v1, /sync). Ronan, 15 Nov 2026.
 *  - Ronan's columns (General admin, Critical, Costings, Email replies...; his email automation fills them) become
 *    Ronan's dashboard to-dos, labelled with the column. The "Personal" column stays out of the dashboard.
 *  - "Judy's list" and "Anel's list" columns: what Ronan adds there goes on that person's dashboard list, and their
 *    dashboard tasks show there. Ticking off on either side ticks off the other; moving a card between columns moves it.
 *  - "From the dashboard" column: Ronan's due list (chases, set-ups, renewals...), closing itself once dealt with.
 *  - Tasks Ronan adds on the dashboard go on the board with no column (top of the board).
 * Needs TODOIST_API_TOKEN (Todoist > Settings > Integrations > Developer) in Vercel.
 */
const API = "https://api.todoist.com/api/v1/sync";
const PROJECT = process.env.TODOIST_PROJECT ?? "Work list";
const TEAM = "Beamore"; // shared lists: Judy's list, Anel's list, From the dashboard
const DUE = "From the dashboard";
const EXCLUDED = new Set(["personal"]); // columns never shown on the dashboard
const LIST_PEOPLE = (process.env.TODOIST_LIST_PEOPLE ?? "Judy,Anel").split(",").map((s) => s.trim().toLowerCase());
const SITE = "https://dashboard.beamore.co.uk";
export const WORK_LIST_KIND = "Work list"; // tasks.kind prefix for Ronan's board cards (kept private to Ronan)

type Item = { id: string; content: string; description?: string; project_id: string; section_id: string | null; checked?: boolean; completed_at?: string | null; is_deleted?: boolean; due?: { date: string } | null };
type Cmd = { type: string; args: Record<string, unknown>; uuid?: string; temp_id?: string };
type SyncResponse = {
  sync_token: string; items?: Item[];
  projects?: { id: string; name: string; is_deleted?: boolean; is_archived?: boolean }[];
  sections?: { id: string; name: string; project_id: string; is_deleted?: boolean; is_archived?: boolean }[];
  sync_status?: Record<string, unknown>; temp_id_mapping?: Record<string, string>;
};

export const todoistConfigured = () => !!process.env.TODOIST_API_TOKEN;

async function call(body: Record<string, string>): Promise<SyncResponse> {
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Todoist ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function send(cmds: Cmd[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < cmds.length; i += 90) { // Todoist accepts up to 100 commands per request
    const batch = cmds.slice(i, i + 90).map((c) => ({ ...c, uuid: c.uuid ?? randomUUID() }));
    const r = await call({ commands: JSON.stringify(batch) });
    const bad = Object.entries(r.sync_status ?? {}).filter(([, v]) => v !== "ok");
    if (bad.length) throw new Error(`Todoist refused ${bad.length} change(s): ${JSON.stringify(bad[0][1]).slice(0, 150)}`);
    Object.assign(out, r.temp_id_mapping ?? {});
  }
  return out;
}

/** Raw Todoist commands (used to add comments to cards). */
export async function todoistCommands(cmds: Cmd[]) { return send(cmds); }

/** Cards ticked off in a project over the last N days (title, description, when). */
export async function todoistCompleted(projectId: string, days: number) {
  const out: { id: string; content: string; description?: string; completed_at?: string }[] = [];
  const until = new Date(), since = new Date(Date.now() - days * 864e5);
  // the API takes at most about 3 months per call, in windows
  for (let from = since; from < until; from = new Date(from.getTime() + 80 * 864e5)) {
    const to = new Date(Math.min(until.getTime(), from.getTime() + 80 * 864e5));
    let cursor: string | null = null;
    do {
      const q = new URLSearchParams({ since: from.toISOString(), until: to.toISOString(), project_id: projectId, limit: "200", ...(cursor ? { cursor } : {}) });
      const res = await fetch(`https://api.todoist.com/api/v1/tasks/completed/by_completion_date?${q}`, { headers: { Authorization: `Bearer ${process.env.TODOIST_API_TOKEN}` }, cache: "no-store" });
      if (!res.ok) throw new Error(`Todoist completed ${res.status}: ${(await res.text()).slice(0, 150)}`);
      const j = (await res.json()) as { items?: typeof out; next_cursor?: string | null };
      out.push(...(j.items ?? []));
      cursor = j.next_cursor ?? null;
    } while (cursor);
  }
  return out;
}

/** A full read of projects, columns and open cards (the email-to-to-do job). */
export async function todoistBoard() {
  return call({ sync_token: "*", resource_types: JSON.stringify(["projects", "sections", "items"]) });
}

const finished = (i: Item) => !!i.checked || !!i.completed_at || !!i.is_deleted;
const firstOf = (name: string) => name.trim().split(/[\s']/)[0].toLowerCase();

export async function syncTodoist(admin: SupabaseClient) {
  if (!todoistConfigured()) return { ok: false, message: "TODOIST_API_TOKEN isn't set" };
  const { data: st } = await admin.from("todoist_state").select("*").eq("id", 1).maybeSingle();
  const { data: me } = await admin.from("profiles").select("id,email,full_name,role").eq("role", "director").limit(1).single();
  if (!me) return { ok: false, message: "No director profile" };
  const types = JSON.stringify(["projects", "sections", "items"]);

  // ---- two projects: the Work list board (Ronan's own) and "Beamore" (Judy's list, Anel's list, From the dashboard).
  // Free Todoist caps the columns a project can have and the Work list is full, so the shared lists live in Beamore.
  let r = await call({ sync_token: st?.sync_token ?? "*", resource_types: types });
  let projectId: string | null = st?.project_id ?? null;
  let teamId: string | null = st?.tasks_section_id ?? null; // (this column holds the Beamore project's id)
  const live = (id: string | null, name: string) => { const p = (r.projects ?? []).find((x) => x.id === id); return !p || (!p.is_deleted && !p.is_archived && p.name === name); };
  if (!projectId || !teamId || !live(projectId, PROJECT) || !live(teamId, TEAM)) {
    r = await call({ sync_token: "*", resource_types: types });
    const find = (name: string) => (r.projects ?? []).find((p) => p.name === name && !p.is_deleted && !p.is_archived)?.id ?? null;
    projectId = find(PROJECT);
    if (!projectId) return { ok: false, message: `No Todoist project called "${PROJECT}"` };
    teamId = find(TEAM) ?? (await send([{ type: "project_add", temp_id: "p", args: { name: TEAM, color: "red" } }])).p;
  }

  const staff = await staffPeople(admin);
  const listPeople = staff.filter((p) => p.role !== "director" && LIST_PEOPLE.includes(p.first.toLowerCase()));
  // every column we know of: remembered from earlier runs, updated with what changed (an incremental sync lists only changes)
  type Sec = { id: string; name: string; project_id: string };
  const known = new Map<string, Sec>(Object.entries((st as { sections?: Record<string, Sec> } | null)?.sections ?? {}));
  for (const x of r.sections ?? []) { if (x.is_deleted || x.is_archived) known.delete(x.id); else known.set(x.id, { id: x.id, name: x.name, project_id: x.project_id }); }
  let allSecs = [...known.values()].filter((x) => x.project_id === projectId || x.project_id === teamId);
  // tidy-up: an earlier version made the shared columns again on every run. On a full read, keep one of each
  // (the one with cards, else the oldest) and delete only the EMPTY copies of the dashboard's own column names.
  if (r.items && (st?.sync_token == null || !st?.sections || Object.keys((st as { sections?: object }).sections ?? {}).length === 0)) {
    const ours = (n: string) => n === DUE || /^\S+'s list$/.test(n);
    const count = new Map<string, number>();
    for (const i of r.items) if (i.section_id && !finished(i)) count.set(i.section_id, (count.get(i.section_id) ?? 0) + 1);
    const del: Cmd[] = [];
    for (const name of new Set(allSecs.filter((x) => ours(x.name)).map((x) => x.name))) {
      const same = allSecs.filter((x) => x.name === name).sort((p, q) => (count.get(q.id) ?? 0) - (count.get(p.id) ?? 0) || Number(q.project_id === teamId) - Number(p.project_id === teamId));
      for (const x of same.slice(1)) if (!count.get(x.id)) del.push({ type: "section_delete", args: { id: x.id } });
    }
    if (del.length) {
      await send(del);
      const gone = new Set(del.map((d) => d.args.id as string));
      for (const id of gone) known.delete(id);
      allSecs = allSecs.filter((x) => !gone.has(x.id));
      await admin.from("portal_audit").insert({ actor: "dashboard", action: "todoist-duplicate-columns-removed", detail: { count: del.length } });
    }
  }
  let dueSec: string | null = allSecs.find((x) => x.name === DUE && x.project_id === teamId)?.id ?? st?.due_section_id ?? null;
  const personSec = new Map<string, StaffPerson>(); // section id -> person
  const sectionFor = new Map<string, string>();      // person email -> section id (the Beamore project's, preferably)
  for (const x of [...allSecs].sort((p, q) => Number(q.project_id === teamId) - Number(p.project_id === teamId))) {
    const p = listPeople.find((o) => firstOf(x.name) === o.first.toLowerCase());
    if (p) { personSec.set(x.id, p); if (!sectionFor.has(p.email)) sectionFor.set(p.email, x.id); }
  }
  const make: Cmd[] = [];
  if (!dueSec) make.push({ type: "section_add", temp_id: "d", args: { name: DUE, project_id: teamId } });
  const missing = listPeople.filter((p) => !sectionFor.has(p.email));
  missing.forEach((p, n) => make.push({ type: "section_add", temp_id: `s${n}`, args: { name: `${p.first}'s list`, project_id: teamId } }));
  if (make.length) {
    const m = await send(make);
    dueSec = dueSec ?? m.d ?? null;
    missing.forEach((p, n) => { if (m[`s${n}`]) { sectionFor.set(p.email, m[`s${n}`]); personSec.set(m[`s${n}`], p); } });
  }
  if (dueSec && !known.has(dueSec)) known.set(dueSec, { id: dueSec, name: DUE, project_id: teamId! });
  for (const [email, id] of sectionFor) if (!known.has(id)) known.set(id, { id, name: `${listPeople.find((p) => p.email === email)?.first}'s list`, project_id: teamId! });
  const secName = new Map([...known.values()].map((x) => [x.id, x.name]));
  const excluded = (sectionId: string | null) => !!sectionId && EXCLUDED.has((secName.get(sectionId) ?? "").trim().toLowerCase());
  const moved = 0;
  const items = (r.items ?? []).filter((i) => i.project_id === projectId || i.project_id === teamId);

  /** Who a card belongs to and its label, from where it is. */
  const ownerFor = (sectionId: string | null, project?: string) => {
    const p = sectionId ? personSec.get(sectionId) : undefined;
    if (p) return { owner_id: p.profileId, owner_name: p.first, kind: "Added by Ronan (Todoist)" };
    const col = sectionId ? secName.get(sectionId) : null;
    const where = project === teamId ? TEAM : null;
    return { owner_id: me.id, owner_name: null as string | null, kind: [WORK_LIST_KIND, where, col].filter(Boolean).join(" · ") };
  };

  // ---- Todoist -> dashboard
  const { data: linked } = await admin.from("tasks").select("id,todoist_id,title,due,done_at,owner_id,owner_name,kind").not("todoist_id", "is", null);
  const byTid = new Map((linked ?? []).map((t) => [t.todoist_id as string, t]));
  let added = 0, ticked = 0;
  for (const i of items.filter((x) => x.section_id !== dueSec)) {
    const t = byTid.get(i.id);
    if (excluded(i.section_id)) { // moved into Personal: off the dashboard
      if (t && !t.done_at) await admin.from("tasks").update({ done_at: new Date().toISOString() }).eq("id", t.id);
      continue;
    }
    if (!t) {
      if (finished(i)) continue;
      await admin.from("tasks").insert({ ...ownerFor(i.section_id, i.project_id), title: i.content.slice(0, 300), due: i.due?.date?.slice(0, 10) ?? null, todoist_id: i.id });
      added++;
    } else if (finished(i)) {
      if (!t.done_at) { await admin.from("tasks").update({ done_at: new Date().toISOString() }).eq("id", t.id); ticked++; }
    } else {
      const due = i.due?.date?.slice(0, 10) ?? null;
      const o = ownerFor(i.section_id, i.project_id);
      // a task made on the dashboard keeps its own label while it stays in the board's top area
      const kind = !i.section_id && t.kind && !t.kind.startsWith(WORK_LIST_KIND) ? t.kind : o.kind;
      if (t.title !== i.content || t.due !== due || t.owner_id !== o.owner_id || t.owner_name !== o.owner_name || t.kind !== kind)
        await admin.from("tasks").update({ title: i.content.slice(0, 300), due, owner_id: o.owner_id, owner_name: o.owner_name, kind }).eq("id", t.id);
    }
  }
  for (const i of items.filter((x) => x.section_id === dueSec && finished(x)))
    await admin.from("todoist_due_items").update({ ticked_in_todoist_at: new Date().toISOString() }).eq("todoist_id", i.id).is("ticked_in_todoist_at", null);

  // ---- dashboard -> Todoist: tasks for Ronan, Judy and Anel
  const cmds: Cmd[] = [];
  const { data: all } = await admin.from("tasks").select("id,title,due,link,done_at,todoist_id,owner_id,owner_name");
  /** Where a dashboard task goes on the board: Ronan's (no column), or that person's list; anyone else's aren't sent. */
  const target = (t: { owner_id: string | null; owner_name: string | null }): { section_id?: string } | null => {
    if (t.owner_id === me.id) return {};
    const p = listPeople.find((o) => (t.owner_id && o.profileId === t.owner_id) || (!t.owner_id && t.owner_name && o.first.toLowerCase() === t.owner_name.toLowerCase()));
    const s = p ? sectionFor.get(p.email) : undefined;
    return s ? { section_id: s } : null;
  };
  const newTasks = (all ?? []).filter((t) => !t.todoist_id && !t.done_at && target(t));
  newTasks.forEach((t, n) => cmds.push({ type: "item_add", temp_id: `t${n}`, args: {
    content: t.title, project_id: projectId, ...target(t), description: t.link ? `${SITE}${t.link}` : "", ...(t.due ? { due: { date: t.due } } : {}),
  } }));
  // ticked off on the dashboard: tick off on the board too (once; the sync only reports cards that changed)
  const { data: sentBefore } = await admin.from("portal_audit").select("detail").eq("action", "todoist-closed").gte("at", new Date(Date.now() - 60 * 864e5).toISOString());
  const already = new Set((sentBefore ?? []).map((a) => (a.detail as { id: string }).id));
  const closedHere = (all ?? []).filter((t) => t.todoist_id && t.done_at && !already.has(t.todoist_id) && !items.some((i) => i.id === t.todoist_id && (finished(i) || excluded(i.section_id))));
  for (const t of closedHere) cmds.push({ type: "item_complete", args: { id: t.todoist_id } });
  // moved to someone else on the dashboard's due list: the card moves to their column too (a joint job goes on
  // Ronan's), otherwise the board would move it back next time it changed (16 Nov 2026)
  const { data: moveAsks } = await admin.from("portal_audit").select("detail").eq("action", "todoist-move-wanted").gte("at", new Date(Date.now() - 14 * 864e5).toISOString());
  const { data: movesDone } = await admin.from("portal_audit").select("detail").eq("action", "todoist-moved").gte("at", new Date(Date.now() - 14 * 864e5).toISOString());
  const doneMoves = new Set((movesDone ?? []).map((a) => (a.detail as { ask: string }).ask));
  const movesNow: { ask: string }[] = [];
  for (const a of moveAsks ?? []) {
    const d = a.detail as { ask: string; task: string };
    const t = (all ?? []).find((x) => x.id === d.task);
    if (doneMoves.has(d.ask) || !t?.todoist_id || t.done_at) continue;
    const where = target(t) ?? {};
    cmds.push({ type: "item_move", args: { id: t.todoist_id, ...(where.section_id ? { section_id: where.section_id } : { project_id: projectId }) } });
    movesNow.push({ ask: d.ask });
  }

  // ---- dashboard -> Todoist: Ronan's due list (tasks are above)
  const due = (await buildDueList(admin, me as Profile)).filter((d) => !d.taskId && (d.ownerId === me.id || d.owner === null || (d.owner ?? "").split(/\s+or\s+/).includes("Ronan")));
  const { data: mirrored } = await admin.from("todoist_due_items").select("due_key,todoist_id,title,ticked_in_todoist_at");
  const have = new Map((mirrored ?? []).map((m) => [m.due_key, m]));
  const nowKeys = new Set(due.map((d) => d.key));
  const newDue = due.filter((d) => !have.has(d.key));
  newDue.forEach((d, n) => cmds.push({ type: "item_add", temp_id: `d${n}`, args: {
    content: d.title, project_id: teamId, section_id: dueSec,
    description: [d.detail, d.link ? `${SITE}${d.link}` : null].filter(Boolean).join("\n"), ...(d.due ? { due: { date: d.due } } : {}),
  } }));
  for (const d of due) {
    const m = have.get(d.key);
    if (m && !m.ticked_in_todoist_at && m.title !== d.title) cmds.push({ type: "item_update", args: { id: m.todoist_id, content: d.title } });
  }
  const dealtWith = (mirrored ?? []).filter((m) => !nowKeys.has(m.due_key));
  for (const m of dealtWith) if (!m.ticked_in_todoist_at) cmds.push({ type: "item_complete", args: { id: m.todoist_id } });

  const ids = cmds.length ? await send(cmds) : {};
  for (const [n, t] of newTasks.entries()) if (ids[`t${n}`]) await admin.from("tasks").update({ todoist_id: ids[`t${n}`] }).eq("id", t.id);
  for (const [n, d] of newDue.entries()) if (ids[`d${n}`]) await admin.from("todoist_due_items").upsert({ due_key: d.key, todoist_id: ids[`d${n}`], title: d.title });
  for (const d of due) { const m = have.get(d.key); if (m && m.title !== d.title) await admin.from("todoist_due_items").update({ title: d.title }).eq("due_key", d.key); }
  if (dealtWith.length) await admin.from("todoist_due_items").delete().in("due_key", dealtWith.map((m) => m.due_key));
  if (closedHere.length) await admin.from("portal_audit").insert(closedHere.map((t) => ({ actor: "dashboard", action: "todoist-closed", detail: { id: t.todoist_id } })));
  if (movesNow.length) await admin.from("portal_audit").insert(movesNow.map((m) => ({ actor: "dashboard", action: "todoist-moved", detail: m })));

  // a fresh sync token after our own changes, so they aren't read back next time as new
  const fin = await call({ sync_token: r.sync_token, resource_types: JSON.stringify(["items"]) });
  await admin.from("todoist_state").upsert({ id: 1, sync_token: fin.sync_token, project_id: projectId, tasks_section_id: teamId, due_section_id: dueSec, sections: Object.fromEntries(known), last_run: new Date().toISOString() });
  return { ok: true, message: `${moved ? `${moved} cards moved from the old Beamore project; ` : ""}${added} new from Todoist, ${ticked} ticked off there; sent ${newTasks.length} tasks and ${newDue.length} due items; ${dealtWith.length + closedHere.length} closed` };
}
