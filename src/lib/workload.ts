import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadHolidays } from "@/lib/reports/days";

/**
 * Workload (Ronan, 17 Nov 2026): looking ahead, the days each clerk of works is booked for per month from the cost
 * schedules of the jobs they're allocated to, against the working days they have, so we can see who needs help and
 * who is going quiet. Building and M&E are worked out separately (clerk_id / clerk_me_id on the project).
 */
export type Kind = "building" | "me";
export type WProject = {
  id: string; number: number | null; name: string; stage: string;
  possible: boolean;               // a proposal that's been sent, not yet won
  days: number[]; witness: number[]; edited: boolean[];
};
export type WClerk = {
  id: string | null; name: string; daysPerWeek: number;
  avail: number[] | null;          // null for "No clerk yet"
  off: number[];                   // holiday days that month
  planned: number[];               // won jobs only
  possible: number[];              // proposals out
  diary: number[];                 // already in the diary
  projects: WProject[];
};
export type Workload = { months: string[]; working: number[]; sections: Record<Kind, WClerk[]> };

const STAGES = ["sent", "won_arranging", "won_preparing", "live", "on_hold"];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const r1 = (n: number) => Math.round(n * 10) / 10;

export function monthList(start: string, n: number) {
  const out: string[] = [];
  const d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  for (let i = 0; i < n; i++) { out.push(iso(d)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

/** Mon-Fri days in the month that aren't England & Wales bank holidays. */
export function workingDays(month: string, h: Set<string>) {
  const d = new Date(`${month}T00:00:00Z`), m = d.getUTCMonth();
  let n = 0;
  for (; d.getUTCMonth() === m; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6 !== 0 && !h.has(iso(d))) n++;
  return n;
}

export async function loadWorkload(db: SupabaseClient, start: string, n = 13): Promise<Workload> {
  const months = monthList(start, n);
  const end = monthList(months[n - 1], 2)[1];
  const idx = (m: string) => months.indexOf(`${m.slice(0, 7)}-01`);
  const h = await loadHolidays();
  const working = months.map((m) => workingDays(m, h));

  const [{ data: projects }, { data: absences }, { data: diary }] = await Promise.all([
    db.from("projects").select("id,number,name,display_name,stage,clerk_id,clerk_me_id").in("stage", STAGES),
    db.from("absences").select("clerk_id,date_from,date_to,part_day,status").neq("status", "cancelled").lte("date_from", end).gte("date_to", months[0]),
    db.rpc("clerk_diary_days", { d_from: months[0], d_to: end }),
  ]);
  const ps = projects ?? [];
  const ids = ps.map((p) => p.id);
  const plans: { project_id: string; month: string; building: number; me: number; building_witness: number; me_witness: number }[] = [];
  const edits: { project_id: string; month: string; kind: Kind; days: number }[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = ids.slice(i, i + 150);
    const [{ data: pm }, { data: ov }] = await Promise.all([
      db.from("project_planned_months").select("project_id,month,building,me,building_witness,me_witness").in("project_id", chunk).gte("month", months[0]).lt("month", end),
      db.from("workload_overrides").select("project_id,month,kind,days").in("project_id", chunk).gte("month", months[0]).lt("month", end),
    ]);
    plans.push(...(pm ?? [])); edits.push(...(ov ?? []));
  }

  const clerkIds = [...new Set(ps.flatMap((p) => [p.clerk_id, p.clerk_me_id]).filter(Boolean))] as string[];
  const { data: clerks } = clerkIds.length ? await db.from("clerks").select("id,name,days_per_week").in("id", clerkIds) : { data: [] };
  const clerkById = new Map((clerks ?? []).map((c) => [c.id as string, c as { id: string; name: string; days_per_week: number | null }]));

  // holiday days per clerk per month (weekdays only, half for a part day)
  const off = new Map<string, number[]>();
  for (const a of absences ?? []) {
    const row = off.get(a.clerk_id) ?? months.map(() => 0);
    for (const d = new Date(`${a.date_from}T00:00:00Z`); iso(d) <= a.date_to; d.setUTCDate(d.getUTCDate() + 1)) {
      const i = idx(iso(d));
      if (i >= 0 && d.getUTCDay() % 6 !== 0 && !h.has(iso(d))) row[i] += a.part_day ? 0.5 : 1;
    }
    off.set(a.clerk_id, row);
  }
  const diaryBy = new Map<string, number[]>();
  for (const v of (diary ?? []) as { clerk_id: string; kind: Kind; month: string; days: number }[]) {
    const k = `${v.kind}|${v.clerk_id}`, row = diaryBy.get(k) ?? months.map(() => 0), i = idx(v.month);
    if (i >= 0) row[i] += Number(v.days);
    diaryBy.set(k, row);
  }

  const sections = {} as Record<Kind, WClerk[]>;
  for (const kind of ["building", "me"] as Kind[]) {
    const byClerk = new Map<string, WClerk>();
    const get = (id: string | null) => {
      const key = id ?? "none";
      let c = byClerk.get(key);
      if (!c) {
        const info = id ? clerkById.get(id) : null;
        const dpw = Number(info?.days_per_week ?? 5);
        const o = (id && off.get(id)) || months.map(() => 0);
        c = {
          id, name: info?.name ?? "No clerk yet", daysPerWeek: dpw, off: o,
          avail: id ? working.map((w, i) => Math.max(0, r1((w * dpw) / 5 - o[i]))) : null,
          planned: months.map(() => 0), possible: months.map(() => 0),
          diary: (id && diaryBy.get(`${kind}|${id}`)) || months.map(() => 0), projects: [],
        };
        byClerk.set(key, c);
      }
      return c;
    };
    for (const p of ps) {
      const days = months.map(() => 0), witness = months.map(() => 0), edited = months.map(() => false);
      for (const r of plans) if (r.project_id === p.id) {
        const i = idx(r.month);
        if (i >= 0) { days[i] += Number(r[kind]); witness[i] += Number(kind === "me" ? r.me_witness : r.building_witness); }
      }
      for (const e of edits) if (e.project_id === p.id && e.kind === kind) {
        const i = idx(e.month);
        if (i < 0) continue;
        witness[i] = days[i] ? r1((witness[i] * Number(e.days)) / days[i]) : 0;
        days[i] = Number(e.days); edited[i] = true;
      }
      if (!days.some((d) => d > 0) && !edited.some(Boolean)) continue;
      const clerkId = (kind === "me" ? p.clerk_me_id : p.clerk_id) as string | null;
      const c = get(clerkId);
      const possible = p.stage === "sent";
      c.projects.push({ id: p.id, number: p.number, name: p.display_name ?? p.name, stage: p.stage, possible, days, witness, edited });
      days.forEach((d, i) => { if (possible) c.possible[i] += d; else c.planned[i] += d; });
    }
    const list = [...byClerk.values()];
    for (const c of list) c.projects.sort((a, b) => Number(a.possible) - Number(b.possible) || firstMonth(a.days) - firstMonth(b.days));
    // busiest first (most over their days at any point), "No clerk yet" last
    const pressure = (c: WClerk) => (c.avail ? Math.max(...c.planned.map((p, i) => p - c.avail![i])) : -1e9);
    sections[kind] = list.sort((a, b) => pressure(b) - pressure(a) || a.name.localeCompare(b.name));
  }
  return { months, working, sections };
}
const firstMonth = (d: number[]) => { const i = d.findIndex((x) => x > 0); return i < 0 ? 99 : i; };

