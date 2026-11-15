import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDueList } from "@/lib/due";
import type { Profile } from "@/lib/auth";
import { staffPeople, type StaffPerson } from "@/lib/staff";

/**
 * Two-way link with Ronan's Todoist (Todoist API v1, /sync). Everything lives in one Todoist project, "Beamore":
 *  - section "My tasks": anything Ronan adds in the Beamore project (e.g. from his phone) becomes a dashboard task, and
 *    dashboard tasks for Ronan appear there. Ticking off on either side ticks off the other.
 *  - section "From the dashboard": Ronan's due list (chases, set-ups, clerk renewals...), kept up to date. Items close by
 *    themselves once they're dealt with in the dashboard. Ticking one in Todoist just hides it in Todoist.
 *  - one section per person ("Judy's list", "Anel's list"...): what Ronan adds there goes on that person's list in the
 *    dashboard, and their dashboard tasks show there, both ways. A section is matched by the first name it starts with;
 *    a section for someone without dashboard access still works (the task is shown under that name).
 * Needs TODOIST_API_TOKEN (Todoist > Settings > Integrations > Developer), added in Vercel by Ronan.
 */
const API = "https://api.todoist.com/api/v1/sync";
const PROJECT = "Beamore";
const TASKS = "My tasks";
const DUE = "From the dashboard";
const SITE = "https://dashboard.beamore.co.uk";

type Item = { id: string; content: string; description?: string; project_id: string; section_id: string | null; checked?: boolean; completed_at?: string | null; is_deleted?: boolean; due?: { date: string } | null };
type Cmd = { type: string; args: Record<string, unknown>; uuid?: string; temp_id?: string };
type SyncResponse = {
  sync_token: string; items?: Item[];
  projects?: { id: string; name: string; is_deleted?: boolean; is_archived?: boolean }[];
  sections?: { id: string; name: string; project_id: string; is_deleted?: boolean }[];
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

const finished = (i: Item) => !!i.checked || !!i.completed_at || !!i.is_deleted;

export async function syncTodoist(admin: SupabaseClient) {
  if (!todoistConfigured()) return { ok: false, message: "TODOIST_API_TOKEN isn't set" };
  const { data: st } = await admin.from("todoist_state").select("*").eq("id", 1).maybeSingle();
  const { data: me } = await admin.from("profiles").select("id,email,full_name,role").eq("role", "director").limit(1).single();
  if (!me) return { ok: false, message: "No director profile" };
  const types = JSON.stringify(["projects", "sections", "items"]);

  // ---- read changes (first run: everything) and make sure the project and its sections exist
  let r = await call({ sync_token: st?.sync_token ?? "*", resource_types: types });
  let projectId: string | null = st?.project_id ?? null;
  let tasksSec: string | null = st?.tasks_section_id ?? null, dueSec: string | null = st?.due_section_id ?? null;
  const gone = (r.projects ?? []).find((p) => p.id === projectId && (p.is_deleted || p.is_archived));
  if (gone || !projectId) {
    projectId = tasksSec = dueSec = null; // first run, or Ronan removed the project: find or make it again
    r = await call({ sync_token: "*", resource_types: types });
    projectId = (r.projects ?? []).find((p) => p.name === PROJECT && !p.is_deleted && !p.is_archived)?.id ?? null;
    if (!projectId) projectId = (await send([{ type: "project_add", temp_id: "p", args: { name: PROJECT, color: "red" } }])).p;
  }
  const secs = (r.sections ?? []).filter((x) => x.project_id === projectId && !x.is_deleted);
  tasksSec = tasksSec ?? secs.find((x) => x.name === TASKS)?.id ?? null;
  dueSec = dueSec ?? secs.find((x) => x.name === DUE)?.id ?? null;
  const make: Cmd[] = [];
  if (!tasksSec) make.push({ type: "section_add", temp_id: "t", args: { name: TASKS, project_id: projectId } });
  if (!dueSec) make.push({ type: "section_add", temp_id: "d", args: { name: DUE, project_id: projectId } });
  const staff = await staffPeople(admin);
  const others = staff.filter((p) => p.role !== "director");
  const firstOf = (name: string) => name.trim().split(/[\s']/)[0].toLowerCase();
  const personSec = new Map<string, StaffPerson>(); // section id -> person
  const sectionFor = new Map<string, string>();      // person email -> section id
  for (const x of secs) {
    if (x.id === tasksSec || x.id === dueSec) continue;
    const p = others.find((o) => firstOf(x.name) === o.first.toLowerCase());
    if (p) { personSec.set(x.id, p); if (!sectionFor.has(p.email)) sectionFor.set(p.email, x.id); }
  }
  others.filter((p) => !sectionFor.has(p.email)).forEach((p, n) => make.push({ type: "section_add", temp_id: `s${n}`, args: { name: `${p.first}'s list`, project_id: projectId } }));
  if (make.length) {
    const m = await send(make); tasksSec = tasksSec ?? m.t; dueSec = dueSec ?? m.d;
    others.filter((p) => !sectionFor.has(p.email)).forEach((p, n) => { if (m[`s${n}`]) { sectionFor.set(p.email, m[`s${n}`]); personSec.set(m[`s${n}`], p); } });
  }
  const secName = new Map(secs.map((x) => [x.id, x.name]));
  /** Who an item belongs to, from the section it's in. */
  const ownerFor = (sectionId: string | null) => {
    if (!sectionId || sectionId === tasksSec) return { owner_id: me.id, owner_name: null as string | null };
    const p = personSec.get(sectionId);
    if (p) return { owner_id: p.profileId, owner_name: p.first };
    const n = secName.get(sectionId);
    return { owner_id: null, owner_name: n ? n.trim().split(/[\s']/)[0] : null }; // e.g. a list for someone not on the dashboard yet
  };
  const items = (r.items ?? []).filter((i) => i.project_id === projectId);

  // ---- Todoist -> dashboard (anything in the Beamore project except the due-list mirror)
  const { data: linked } = await admin.from("tasks").select("id,todoist_id,title,due,done_at,owner_id,owner_name").not("todoist_id", "is", null);
  const byTid = new Map((linked ?? []).map((t) => [t.todoist_id as string, t]));
  let added = 0, ticked = 0;
  for (const i of items.filter((x) => x.section_id !== dueSec)) {
    // (sections for each person are created above, so ownerFor knows them)
    const t = byTid.get(i.id);
    if (!t) {
      if (finished(i)) continue;
      await admin.from("tasks").insert({ ...ownerFor(i.section_id), title: i.content.slice(0, 300), kind: "Added by Ronan (Todoist)", due: i.due?.date?.slice(0, 10) ?? null, todoist_id: i.id });
      added++;
    } else if (finished(i)) {
      if (!t.done_at) { await admin.from("tasks").update({ done_at: new Date().toISOString() }).eq("id", t.id); ticked++; }
    } else {
      const due = i.due?.date?.slice(0, 10) ?? null;
      const o = ownerFor(i.section_id);
      if (t.title !== i.content || t.due !== due || t.owner_id !== o.owner_id || (o.owner_id === null && t.owner_name !== o.owner_name))
        await admin.from("tasks").update({ title: i.content.slice(0, 300), due, ...o }).eq("id", t.id); // edited, or moved to someone else's list
    }
  }
  // due-list mirror: remember what Ronan ticked there so it isn't added back
  for (const i of items.filter((x) => x.section_id === dueSec && finished(x)))
    await admin.from("todoist_due_items").update({ ticked_in_todoist_at: new Date().toISOString() }).eq("todoist_id", i.id).is("ticked_in_todoist_at", null);

  // ---- dashboard -> Todoist: Ronan's own tasks
  const cmds: Cmd[] = [];
  const { data: all } = await admin.from("tasks").select("id,title,due,link,done_at,todoist_id,owner_id,owner_name");
  /** The Todoist section for a dashboard task: Ronan's, or that person's list (unassigned tasks aren't sent). */
  const secOf = (t: { owner_id: string | null; owner_name: string | null }) => {
    if (t.owner_id === me.id) return tasksSec;
    const p = others.find((o) => (t.owner_id && o.profileId === t.owner_id) || (!t.owner_id && t.owner_name && o.first.toLowerCase() === t.owner_name.toLowerCase()));
    return p ? sectionFor.get(p.email) ?? null : null;
  };
  const mine = (all ?? []).filter((t) => secOf(t));
  const newTasks = mine.filter((t) => !t.todoist_id && !t.done_at);
  newTasks.forEach((t, n) => cmds.push({ type: "item_add", temp_id: `t${n}`, args: {
    content: t.title, project_id: projectId, section_id: secOf(t), description: t.link ? `${SITE}${t.link}` : "", ...(t.due ? { due: { date: t.due } } : {}),
  } }));
  // ticked off in the dashboard: tick off in Todoist (it ignores items already completed)
  const closedHere = (all ?? []).filter((t) => t.todoist_id && t.done_at && !items.some((i) => i.id === t.todoist_id && finished(i)));
  const { data: closedBefore } = await admin.from("portal_audit").select("detail").eq("action", "todoist-closed").gte("at", new Date(Date.now() - 30 * 864e5).toISOString());
  const already = new Set((closedBefore ?? []).map((a) => (a.detail as { id: string }).id));
  const toClose = closedHere.filter((t) => !already.has(t.todoist_id!));
  for (const t of toClose) cmds.push({ type: "item_complete", args: { id: t.todoist_id } });

  // ---- dashboard -> Todoist: the due list (manual tasks are handled above)
  const due = (await buildDueList(admin, me as Profile)).filter((d) => !d.taskId && (d.ownerId === me.id || d.owner === null || d.owner === "Ronan"));
  const { data: mirrored } = await admin.from("todoist_due_items").select("due_key,todoist_id,title,ticked_in_todoist_at");
  const have = new Map((mirrored ?? []).map((m) => [m.due_key, m]));
  const nowKeys = new Set(due.map((d) => d.key));
  const newDue = due.filter((d) => !have.has(d.key));
  newDue.forEach((d, n) => cmds.push({ type: "item_add", temp_id: `d${n}`, args: {
    content: d.title, project_id: projectId, section_id: dueSec,
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
  if (toClose.length) await admin.from("portal_audit").insert(toClose.map((t) => ({ actor: "dashboard", action: "todoist-closed", detail: { id: t.todoist_id } })));

  // a fresh sync token after our own changes, so they aren't read back next time as new
  const fin = await call({ sync_token: r.sync_token, resource_types: JSON.stringify(["items"]) });
  await admin.from("todoist_state").upsert({ id: 1, sync_token: fin.sync_token, project_id: projectId, tasks_section_id: tasksSec, due_section_id: dueSec, last_run: new Date().toISOString() });
  return { ok: true, message: `${added} new from Todoist, ${ticked} ticked off there; sent ${newTasks.length} tasks and ${newDue.length} due items; ${dealtWith.length + toClose.length} closed` };
}
