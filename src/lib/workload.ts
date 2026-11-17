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
  agreed?: string;                 // work agreed verbally (workload_agreed id): not from a cost schedule
  projectId?: string | null;       // for an agreed line, the job it's on (if it's on the dashboard)
};
export type Agreed = {
  id: string; clerkId: string; clerk: string; projectId: string | null; job: string; kind: Kind;
  days: number; per: "week" | "month"; from: string; to: string | null; note: string | null;
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
/** A won / live job with no planned days from this month on (Ronan, 17 Nov 2026: every job should have a plan). */
export type Unplanned = { id: string; name: string; stage: string; clerks: string; why: string; lastPlanned: string | null };
export type Workload = { months: string[]; working: number[]; sections: Record<Kind, WClerk[]>; agreed: Agreed[]; unplanned: Unplanned[] };

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

/**
 * England & Wales bank holidays worked out for a year (gov.uk only lists about a year ahead): New Year, Good Friday,
 * Easter Monday, first and last Monday of May, last Monday of August, Christmas and Boxing Day, moved off weekends.
 * One-off extra days (coronations and the like) can't be known in advance.
 */
export function englandBankHolidays(y: number) {
  const D = (m: number, d: number) => new Date(Date.UTC(y, m, d));
  const add = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
  const out: Date[] = [];
  const ny = D(0, 1); out.push(ny.getUTCDay() === 6 ? add(ny, 2) : ny.getUTCDay() === 0 ? add(ny, 1) : ny);
  // Easter Sunday (anonymous Gregorian algorithm)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easter = D(Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1);
  out.push(add(easter, -2), add(easter, 1));
  const firstMon = (mo: number) => { const x = D(mo, 1); return add(x, (8 - x.getUTCDay()) % 7); };
  const lastMon = (mo: number) => { const x = D(mo + 1, 0); return add(x, -((x.getUTCDay() + 6) % 7)); };
  out.push(firstMon(4), lastMon(4), lastMon(7));
  const xmas = D(11, 25), dow = xmas.getUTCDay();
  if (dow === 5) out.push(xmas, add(xmas, 3)); else if (dow === 6) out.push(add(xmas, 2), add(xmas, 3)); else if (dow === 0) out.push(add(xmas, 1), add(xmas, 2)); else out.push(xmas, add(xmas, 1));
  return out.map(iso);
}

/**
 * Days a piece of agreed work comes to in a month: "per week" is the days times the working weeks it covers that
 * month (weekdays less bank holidays, over 5); "per month" is the days, cut down for a month it only partly covers.
 * Rounded to the half day.
 */
export function agreedDays(a: { days: number; per: string; date_from: string; date_to: string | null }, month: string, h: Set<string>) {
  const d = new Date(`${month}T00:00:00Z`), m = d.getUTCMonth();
  let all = 0, inside = 0;
  for (; d.getUTCMonth() === m; d.setUTCDate(d.getUTCDate() + 1)) {
    const s = iso(d);
    if (d.getUTCDay() % 6 === 0 || h.has(s)) continue;
    all++;
    if (s >= a.date_from && (!a.date_to || s <= a.date_to)) inside++;
  }
  if (!inside) return 0;
  const v = a.per === "week" ? (Number(a.days) * inside) / 5 : (Number(a.days) * inside) / all;
  return Math.max(0.5, Math.round(v * 2) / 2);
}

export async function loadWorkload(db: SupabaseClient, start: string, n = 13): Promise<Workload> {
  const months = monthList(start, n);
  const end = monthList(months[n - 1], 2)[1];
  const idx = (m: string) => months.indexOf(`${m.slice(0, 7)}-01`);
  const h = new Set(await loadHolidays());
  // years past the end of the gov.uk list: worked out
  for (const y of new Set(months.map((x) => Number(x.slice(0, 4)))))
    if (![...h].some((d) => d.startsWith(`${y}-`))) englandBankHolidays(y).forEach((d) => h.add(d));
  const working = months.map((m) => workingDays(m, h));

  const [{ data: projects }, { data: absences }, { data: diary }, { data: agreedRows }] = await Promise.all([
    db.from("projects").select("id,number,name,display_name,stage,clerk_id,clerk_me_id,plan_file,proposal_folder_id").in("stage", STAGES),
    db.from("absences").select("clerk_id,date_from,date_to,part_day,status").neq("status", "cancelled").lte("date_from", end).gte("date_to", months[0]),
    db.rpc("clerk_diary_days", { d_from: months[0], d_to: end }),
    db.from("workload_agreed").select("id,clerk_id,project_id,label,kind,days,per,date_from,date_to,note,projects(name,display_name,stage)")
      .lt("date_from", end).or(`date_to.is.null,date_to.gte.${months[0]}`).order("date_from"),
  ]);
  const ps = projects ?? [];
  type AgreedRow = { id: string; clerk_id: string; project_id: string | null; label: string | null; kind: Kind; days: number; per: string; date_from: string; date_to: string | null; note: string | null; projects: { name: string; display_name: string | null; stage: string } | null };
  const ag = (agreedRows ?? []) as unknown as AgreedRow[];
  // months of a job (and building / M&E) covered by agreed work: the cost schedule's days there give way to it
  const agreedMonths = new Set<string>();
  const agreedLine = ag.map((a) => {
    const days = months.map((m) => agreedDays(a, m, h));
    if (a.project_id) days.forEach((d, i) => { if (d) agreedMonths.add(`${a.project_id}|${a.kind}|${i}`); });
    return { a, days };
  });
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

  const clerkIds = [...new Set([...ps.flatMap((p) => [p.clerk_id, p.clerk_me_id]), ...ag.map((a) => a.clerk_id)].filter(Boolean))] as string[];
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
      months.forEach((_, i) => { if (agreedMonths.has(`${p.id}|${kind}|${i}`)) { days[i] = 0; witness[i] = 0; } });
      if (!days.some((d) => d > 0) && !edited.some(Boolean)) continue;
      const clerkId = (kind === "me" ? p.clerk_me_id : p.clerk_id) as string | null;
      const c = get(clerkId);
      const possible = p.stage === "sent";
      c.projects.push({ id: p.id, number: p.number, name: p.display_name ?? p.name, stage: p.stage, possible, days, witness, edited });
      days.forEach((d, i) => { if (possible) c.possible[i] += d; else c.planned[i] += d; });
    }
    for (const { a, days } of agreedLine) {
      if (a.kind !== kind || !days.some((d) => d > 0)) continue;
      const c = get(a.clerk_id);
      const name = a.projects ? (a.projects.display_name ?? a.projects.name) : (a.label ?? "Agreed work");
      c.projects.push({ id: `agreed:${a.id}`, agreed: a.id, projectId: a.project_id, number: null, name, stage: a.projects?.stage ?? "live", possible: false,
        days, witness: months.map(() => 0), edited: months.map(() => false) });
      days.forEach((d, i) => { c.planned[i] += d; });
    }
    const list = [...byClerk.values()];
    for (const c of list) c.projects.sort((a, b) => Number(a.possible) - Number(b.possible) || firstMonth(a.days) - firstMonth(b.days));
    // busiest first (most over their days at any point), "No clerk yet" last
    const pressure = (c: WClerk) => (c.avail ? Math.max(...c.planned.map((p, i) => p - c.avail![i])) : -1e9);
    sections[kind] = list.sort((a, b) => pressure(b) - pressure(a) || a.name.localeCompare(b.name));
  }
  // won / live jobs with nothing planned from this month on, and why
  const lastPlan = new Map<string, string>();
  const noFuture = ids.filter((id) => !plans.some((r) => r.project_id === id));
  for (let i = 0; i < noFuture.length; i += 10) {
    const { data } = await db.from("project_planned_months").select("project_id,month").in("project_id", noFuture.slice(i, i + 10)).order("month", { ascending: false }).limit(1000);
    for (const r of data ?? []) if (!lastPlan.has(r.project_id)) lastPlan.set(r.project_id, r.month);
  }
  const hasFuture = new Set(plans.filter((r) => Number(r.building) + Number(r.me) > 0).map((r) => r.project_id));
  for (const a of ag) if (a.project_id) hasFuture.add(a.project_id);
  const unplanned: Unplanned[] = ps.filter((p) => p.stage !== "sent" && !hasFuture.has(p.id)).map((p) => {
    const last = lastPlan.get(p.id) ?? null;
    const pf = (p.plan_file as string | null) ?? "";
    const why = last ? "The cost schedule runs out before this month"
      : /^no /i.test(pf) ? pf
      : p.proposal_folder_id ? "No month-by-month cost schedule in its Cost Proposals folder"
      : "No Cost Proposals folder found for it";
    const names = [p.clerk_id, p.clerk_me_id].filter(Boolean).map((id) => clerkById.get(id as string)?.name ?? "").filter(Boolean);
    return { id: p.id, name: p.display_name ?? p.name, stage: p.stage, clerks: names.join(" / "), why, lastPlanned: last };
  }).sort((a, b) => Number(!!a.lastPlanned) - Number(!!b.lastPlanned) || a.name.localeCompare(b.name));

  const agreed: Agreed[] = ag.map((a) => ({
    id: a.id, clerkId: a.clerk_id, clerk: clerkById.get(a.clerk_id)?.name ?? "?", projectId: a.project_id,
    job: a.projects ? (a.projects.display_name ?? a.projects.name) : (a.label ?? ""), kind: a.kind,
    days: Number(a.days), per: a.per as "week" | "month", from: a.date_from, to: a.date_to, note: a.note,
  }));
  return { months, working, sections, agreed, unplanned };
}
const firstMonth = (d: number[]) => { const i = d.findIndex((x) => x > 0); return i < 0 ? 99 : i; };

