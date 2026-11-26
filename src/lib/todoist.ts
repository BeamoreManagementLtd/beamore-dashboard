import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildDueList, type DueItem } from "@/lib/due";
import type { Profile } from "@/lib/auth";
import { staffPeople, type StaffPerson } from "@/lib/staff";

/**
 * Two-way link with Ronan's Todoist "Work list" board (Todoist API v1, /sync). Ronan, 15 Nov 2026; one board since 26 Nov 2026
 * ("merge the to-do lists": the second "Beamore" project's cards moved onto the Work list and it was archived).
 *  - Ronan's columns (General admin, Critical, Costings, Email replies...; his email automation fills them) become
 *    Ronan's dashboard to-dos, labelled with the column. The "Personal" column stays out of the dashboard.
 *  - "Judy's list", "Anel's list", "Andy's list": what Ronan adds there goes on that person's dashboard list, and their
 *    dashboard tasks show there. Ticking off on either side ticks off the other; moving a card between columns moves it.
 *  - Ronan's due list (chases, set-ups, renewals...) goes into his own columns (set-ups in Project setups, clerks in
 *    Clerk Set ups, invoice chasing in "Ronan or Judy"...), one card per job, closing itself once dealt with.
 *  - Tasks Ronan adds on the dashboard go on the board with no column (top of the board).
 * Needs TODOIST_API_TOKEN (Todoist > Settings > Integrations > Developer) in Vercel.
 */
const API = "https://api.todoist.com/api/v1/sync";
const PROJECT = process.env.TODOIST_PROJECT ?? "Work list";
const OLD_TEAM = "Beamore"; // the second project (15-26 Nov 2026): its open cards move onto the Work list, then it's archived
/** Things either Ronan or Judy can do (Ronan, 17 Nov 2026): chasing unpaid invoices and Xero invoicing. */
const SHARED = "Ronan or Judy";
const SHARED_KINDS = new Set(["Chasing", "Xero"]);
const EXCLUDED = new Set(["personal"]); // columns never shown on the dashboard
const LIST_PEOPLE = (process.env.TODOIST_LIST_PEOPLE ?? "Judy,Anel,Andy").split(",").map((s) => s.trim().toLowerCase());
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

/** Which Work list column a due-list item goes in (Ronan, 26 Nov 2026: one board, his own columns). */
export function columnFor(d: Pick<DueItem, "kind" | "title">): string {
  if (SHARED_KINDS.has(d.kind)) return SHARED;
  if (d.kind === "Projects") return /^(Price |Ask for a reply|Won or lost|Pricing request|Possible go-ahead)/.test(d.title) ? "Costings" : "Project setups";
  if (d.kind === "Personnel") return "Clerk Set ups";
  return "General admin";
}

/** One card per job: a project's set-up steps (set up, find a clerk, chase the client for information...) share a card. */
const groupOf = (d: DueItem) => {
  const m = /^\/projects\/([0-9a-f-]{36})$/.exec(d.link ?? "");
  return m && columnFor(d) === "Project setups" ? `proj-${m[1]}` : d.key;
};
const rank = (d: DueItem) => (d.key.startsWith("wf-") ? 0 : d.key.startsWith("findclerk-") ? 1 : d.key.startsWith("info-") ? 2 : 3);

export async function syncTodoist(admin: SupabaseClient) {
  if (!todoistConfigured()) return { ok: false, message: "TODOIST_API_TOKEN isn't set" };
  const { data: st } = await admin.from("todoist_state").select("*").eq("id", 1).maybeSingle();
  const { data: me } = await admin.from("profiles").select("id,email,full_name,role").eq("role", "director").limit(1).single();
  if (!me) return { ok: false, message: "No director profile" };
  const types = JSON.stringify(["projects", "sections", "items"]);

  let r = await call({ sync_token: st?.sync_token ?? "*", resource_types: types });
  let projectId: string | null = st?.project_id ?? null;
  let oldTeam: string | null = st?.tasks_section_id ?? null; // the old Beamore project, until it's emptied and archived
  const live = (id: string | null, name: string) => { const p = (r.projects ?? []).find((x) => x.id === id); return !p || (!p.is_deleted && !p.is_archived && p.name === name); };
  // a full read while the old project is still there (its cards are moved off it), or when anything looks wrong
  if (!projectId || !live(projectId, PROJECT) || oldTeam) {
    r = await call({ sync_token: "*", resource_types: types });
    const find = (name: string) => (r.projects ?? []).find((p) => p.name === name && !p.is_deleted && !p.is_archived)?.id ?? null;
    projectId = find(PROJECT);
    if (!projectId) return { ok: false, message: `No Todoist project called "${PROJECT}"` };
    oldTeam = find(OLD_TEAM);
  }

  const staff = await staffPeople(admin);
  const listPeople = staff.filter((p) => p.role !== "director" && LIST_PEOPLE.includes(p.first.toLowerCase()));
  // every column we know of: remembered from earlier runs, updated with what changed (an incremental sync lists only changes)
  type Sec = { id: string; name: string; project_id: string };
  const known = new Map<string, Sec>(Object.entries((st as { sections?: Record<string, Sec> } | null)?.sections ?? {}));
  for (const x of r.sections ?? []) { if (x.is_deleted || x.is_archived) known.delete(x.id); else known.set(x.id, { id: x.id, name: x.name, project_id: x.project_id }); }
  for (const x of known.values()) if (x.project_id !== projectId && x.project_id !== oldTeam) known.delete(x.id);
  const workSecs = () => [...known.values()].filter((x) => x.project_id === projectId);
  const col = (name: string) => workSecs().find((x) => x.name.trim().toLowerCase() === name.toLowerCase())?.id ?? null;

  // the columns the dashboard needs on the Work list: the shared one and each person's list
  const make: Cmd[] = [];
  const wanted = [SHARED, ...listPeople.map((p) => `${p.first}'s list`)];
  wanted.forEach((name, n) => { if (!col(name)) make.push({ type: "section_add", temp_id: `s${n}`, args: { name, project_id: projectId } }); });
  if (make.length) {
    const m = await send(make);
    wanted.forEach((name, n) => { if (m[`s${n}`]) known.set(m[`s${n}`], { id: m[`s${n}`], name, project_id: projectId! }); });
  }
  const sharedSec = col(SHARED);
  const personSec = new Map<string, StaffPerson>(); // section id -> person (either project, so old cards still read right)
  const sectionFor = new Map<string, string>();      // person email -> their Work list column
  for (const x of known.values()) {
    const p = listPeople.find((o) => firstOf(x.name) === o.first.toLowerCase() && /'s list$/i.test(x.name.trim()));
    if (!p) continue;
    personSec.set(x.id, p);
    if (x.project_id === projectId) sectionFor.set(p.email, x.id);
  }
  const secName = new Map([...known.values()].map((x) => [x.id, x.name]));
  const excluded = (sectionId: string | null) => !!sectionId && EXCLUDED.has((secName.get(sectionId) ?? "").trim().toLowerCase());
  const items = (r.items ?? []).filter((i) => i.project_id === projectId || (oldTeam && i.project_id === oldTeam));

  /** Who a card belongs to and its label, from where it is. */
  const ownerFor = (sectionId: string | null) => {
    const p = sectionId ? personSec.get(sectionId) : undefined;
    if (p) return { owner_id: p.profileId, owner_name: p.first, kind: "Added by Ronan (Todoist)" };
    const c = sectionId ? secName.get(sectionId) : null;
    return { owner_id: me.id, owner_name: null as string | null, kind: [WORK_LIST_KIND, c].filter(Boolean).join(" · ") };
  };

  // the dashboard's own due-list cards aren't hand-made to-dos
  const { data: mirrored } = await admin.from("todoist_due_items").select("due_key,todoist_id,title,ticked_in_todoist_at");
  const dueCards = new Set((mirrored ?? []).map((m) => m.todoist_id as string));
  const isDue = (x: { id: string }) => dueCards.has(x.id);

  // ---- Todoist -> dashboard
  const { data: linked } = await admin.from("tasks").select("id,todoist_id,title,due,done_at,owner_id,owner_name,kind").not("todoist_id", "is", null);
  const byTid = new Map((linked ?? []).map((t) => [t.todoist_id as string, t]));
  let added = 0, ticked = 0;
  for (const i of items.filter((x) => !isDue(x))) {
    const t = byTid.get(i.id);
    if (excluded(i.section_id)) { // moved into Personal: off the dashboard
      if (t && !t.done_at) await admin.from("tasks").update({ done_at: new Date().toISOString() }).eq("id", t.id);
      continue;
    }
    if (!t) {
      if (finished(i)) continue;
      await admin.from("tasks").insert({ ...ownerFor(i.section_id), title: i.content.slice(0, 300), due: i.due?.date?.slice(0, 10) ?? null, todoist_id: i.id });
      added++;
    } else if (finished(i)) {
      if (!t.done_at) { await admin.from("tasks").update({ done_at: new Date().toISOString() }).eq("id", t.id); ticked++; }
    } else {
      const due = i.due?.date?.slice(0, 10) ?? null;
      const o = ownerFor(i.section_id);
      // a task made on the dashboard keeps its own label while it stays in the board's top area
      const kind = !i.section_id && t.kind && !t.kind.startsWith(WORK_LIST_KIND) ? t.kind : o.kind;
      if (t.title !== i.content || t.due !== due || t.owner_id !== o.owner_id || t.owner_name !== o.owner_name || t.kind !== kind)
        await admin.from("tasks").update({ title: i.content.slice(0, 300), due, owner_id: o.owner_id, owner_name: o.owner_name, kind }).eq("id", t.id);
    }
  }
  for (const i of items.filter((x) => isDue(x) && finished(x)))
    await admin.from("todoist_due_items").update({ ticked_in_todoist_at: new Date().toISOString() }).eq("todoist_id", i.id).is("ticked_in_todoist_at", null);
  const tickedIds = new Set([
    ...(mirrored ?? []).filter((m) => m.ticked_in_todoist_at).map((m) => m.todoist_id as string),
    ...items.filter((x) => isDue(x) && finished(x)).map((x) => x.id),
  ]);

  const cmds: Cmd[] = [];
  // ---- the old Beamore project: every open card moves to the same place on the Work list, then the project is archived
  let merged = 0;
  const dueByCard = new Map<string, string>(); // card -> a due key, to know its column
  for (const m of mirrored ?? []) dueByCard.set(m.todoist_id as string, m.due_key as string);
  const dueNow = (await buildDueList(admin, me as Profile)).filter((d) => !d.taskId && (d.ownerId === me.id || d.owner === null || (d.owner ?? "").split(/\s+or\s+/).includes("Ronan")));
  const dueByKey = new Map(dueNow.map((d) => [d.key, d]));
  if (oldTeam) {
    for (const i of items.filter((x) => x.project_id === oldTeam && !finished(x))) {
      const from = (secName.get(i.section_id ?? "") ?? "").trim();
      const person = personSec.get(i.section_id ?? "");
      const d = dueByKey.get(dueByCard.get(i.id) ?? "");
      const to = person ? sectionFor.get(person.email) ?? null
        : from.toLowerCase() === SHARED.toLowerCase() ? sharedSec
        : isDue(i) ? col(d ? columnFor(d) : "General admin")
        : null; // "My tasks" and the top of the board: the top of the Work list
      cmds.push({ type: "item_move", args: { id: i.id, ...(to ? { section_id: to } : { project_id: projectId }) } });
      merged++;
    }
  }

  // ---- dashboard -> Todoist: tasks for Ronan and the people with a list
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
  // moved to someone else on the dashboard's due list: the card moves to their column too (16 Nov 2026)
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

  // ---- dashboard -> Todoist: Ronan's due list, one card per job, in his own columns
  const have = new Map((mirrored ?? []).map((m) => [m.due_key as string, m]));
  const groups = new Map<string, DueItem[]>();
  for (const d of dueNow) groups.set(groupOf(d), [...(groups.get(groupOf(d)) ?? []), d]);
  const rows: { due_key: string; todoist_id: string; title: string; ticked_in_todoist_at: string | null }[] = [];
  const newGroups: { temp: string; items: DueItem[]; content: string }[] = [];
  const keepCards = new Set<string>();
  let doubles = 0;
  for (const g of groups.values()) {
    g.sort((a, b) => rank(a) - rank(b));
    const content = g.length > 1 ? `${g[0].title} (and ${g.length - 1} more step${g.length > 2 ? "s" : ""})` : g[0].title;
    const description = g.length > 1
      ? [...g.map((d) => `- ${d.title}${d.detail ? `: ${d.detail}` : ""}`), g[0].link ? `${SITE}${g[0].link}` : null].filter(Boolean).join("\n")
      : [g[0].detail, g[0].link ? `${SITE}${g[0].link}` : null].filter(Boolean).join("\n");
    const cards = [...new Set(g.map((d) => have.get(d.key)?.todoist_id as string | undefined).filter((x): x is string => !!x))];
    if (!cards.length) {
      const temp = `d${newGroups.length}`;
      newGroups.push({ temp, items: g, content });
      cmds.push({ type: "item_add", temp_id: temp, args: {
        content, project_id: projectId, ...(col(columnFor(g[0])) ? { section_id: col(columnFor(g[0])) } : {}), description, ...(g[0].due ? { due: { date: g[0].due } } : {}),
      } });
      continue;
    }
    // keep the open card (the first one), tick off the others: the same job, carded more than once before
    const keep = cards.find((c) => !tickedIds.has(c)) ?? cards[0];
    keepCards.add(keep);
    for (const c of cards) if (c !== keep && !tickedIds.has(c)) { cmds.push({ type: "item_complete", args: { id: c } }); doubles++; }
    const isTicked = tickedIds.has(keep);
    const before = (mirrored ?? []).filter((m) => m.todoist_id === keep);
    const sameKeys = before.length === g.length && g.every((d) => before.some((m) => m.due_key === d.key));
    if (!isTicked && (!sameKeys || before[0]?.title !== content)) cmds.push({ type: "item_update", args: { id: keep, content, description } });
    for (const d of g) rows.push({ due_key: d.key, todoist_id: keep, title: content, ticked_in_todoist_at: isTicked ? (before.find((m) => m.ticked_in_todoist_at)?.ticked_in_todoist_at as string) ?? new Date().toISOString() : null });
  }
  // dealt with: the card closes once none of its steps is left
  const nowKeys = new Set(dueNow.map((d) => d.key));
  const dealtWith = (mirrored ?? []).filter((m) => !nowKeys.has(m.due_key as string));
  const closeCards = new Set(dealtWith.filter((m) => !m.ticked_in_todoist_at && !keepCards.has(m.todoist_id as string)).map((m) => m.todoist_id as string));
  for (const c of closeCards) if (!cmds.some((x) => x.type === "item_complete" && x.args.id === c)) cmds.push({ type: "item_complete", args: { id: c } });

  if (oldTeam && merged === items.filter((x) => x.project_id === oldTeam && !finished(x)).length)
    cmds.push({ type: "project_archive", args: { id: oldTeam } });

  const ids = cmds.length ? await send(cmds) : {};
  for (const [n, t] of newTasks.entries()) if (ids[`t${n}`]) await admin.from("tasks").update({ todoist_id: ids[`t${n}`] }).eq("id", t.id);
  for (const g of newGroups) if (ids[g.temp]) for (const d of g.items) rows.push({ due_key: d.key, todoist_id: ids[g.temp], title: g.content, ticked_in_todoist_at: null });
  if (rows.length) await admin.from("todoist_due_items").upsert(rows, { onConflict: "due_key" });
  if (dealtWith.length) await admin.from("todoist_due_items").delete().in("due_key", dealtWith.map((m) => m.due_key));
  if (closedHere.length) await admin.from("portal_audit").insert(closedHere.map((t) => ({ actor: "dashboard", action: "todoist-closed", detail: { id: t.todoist_id } })));
  if (movesNow.length) await admin.from("portal_audit").insert(movesNow.map((m) => ({ actor: "dashboard", action: "todoist-moved", detail: m })));
  const archived = cmds.some((c) => c.type === "project_archive");
  if (merged || archived) await admin.from("portal_audit").insert({ actor: "dashboard", action: "todoist-merged", detail: { moved: merged, archived } });

  // a fresh sync token after our own changes, so they aren't read back next time as new
  const fin = await call({ sync_token: r.sync_token, resource_types: JSON.stringify(["items"]) });
  await admin.from("todoist_state").upsert({ id: 1, sync_token: fin.sync_token, project_id: projectId, tasks_section_id: archived ? null : oldTeam, due_section_id: null, sections: Object.fromEntries(known), last_run: new Date().toISOString() });
  return { ok: true, message: `${merged ? `${merged} cards moved from the old Beamore project${archived ? " (archived)" : ""}; ` : ""}${added} new from Todoist, ${ticked} ticked off there; sent ${newTasks.length} tasks and ${newGroups.length} due cards; ${doubles} doubled-up cards ticked off; ${closeCards.size + closedHere.length} closed` };
}
