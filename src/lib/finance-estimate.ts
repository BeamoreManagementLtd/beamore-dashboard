import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Next month's net profit estimated from the diary's grey (planned) side (Ronan, 18 Nov 2026: "estimated net profit for
 * the next following month... we should have all the stuff in the gray boxes already on the diary").
 *   fees     = planned days x the job's day rate (the rate kept for the job, else its last invoice: total less VAT over
 *              the days on it; M&E days at the M&E rate where there is one)
 *   clerks   = the cost of each planned slot in the diary (as the clerk is paid)
 *   overheads = the same as Xero's last month (gross profit less net profit)
 */
export type MonthEstimate = {
  month: string; days: number; fees: number; clerks: number; unpricedDays: number; unpriced: { name: string; days: number }[];
};

const nextMonth = (m: string) => { const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 1)); return d.toISOString().slice(0, 10); };

export async function estimateMonth(db: SupabaseClient, m: string): Promise<MonthEstimate> {
  const visits: { project_id: string | null; kind: string; days: number; clerk_costs: { cost: number } | null; projects: { display_name: string | null } | null }[] = [];
  for (let i = 0; ; i += 1000) {
    const { data } = await db.from("diary_visits").select("project_id,kind,days,clerk_costs(cost),projects(display_name)")
      .eq("side", "planned").gte("visit_date", m).lt("visit_date", nextMonth(m)).range(i, i + 999);
    visits.push(...((data ?? []) as unknown as typeof visits));
    if ((data ?? []).length < 1000) break;
  }
  const ids = [...new Set(visits.map((v) => v.project_id).filter(Boolean))] as string[];
  const rates = new Map<string, { b: number | null; me: number | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [{ data: pf }, { data: inv }] = await Promise.all([
      db.from("project_finance").select("project_id,charge_rate_building,charge_rate_me").in("project_id", chunk),
      db.from("invoices").select("project_id,total,days_building,days_me,status,issued").in("project_id", chunk).order("issued", { ascending: false }),
    ]);
    for (const id of chunk) {
      const f = (pf ?? []).find((x) => x.project_id === id);
      const mine = (inv ?? []).filter((x) => x.project_id === id && !/void|deleted/i.test(x.status ?? "") && Number(x.total) > 0);
      const only = (k: "b" | "me") => mine.find((x) => (k === "b" ? Number(x.days_building) > 0 && !Number(x.days_me) : Number(x.days_me) > 0 && !Number(x.days_building)));
      const perDay = (x?: { total: number; days_building: number | null; days_me: number | null }) => {
        const d = x ? Number(x.days_building ?? 0) + Number(x.days_me ?? 0) : 0;
        return x && d ? Number(x.total) / 1.2 / d : null;
      };
      const mixed = perDay(mine.find((x) => Number(x.days_building ?? 0) + Number(x.days_me ?? 0) > 0));
      const b = Number(f?.charge_rate_building) || perDay(only("b")) || mixed;
      const me = Number(f?.charge_rate_me) || perDay(only("me")) || b;
      rates.set(id, { b: b || null, me: me || null });
    }
  }
  let days = 0, fees = 0, clerks = 0, unpricedDays = 0;
  const unpriced = new Map<string, number>();
  for (const v of visits) {
    const d = Number(v.days);
    days += d;
    clerks += Number(v.clerk_costs?.cost ?? 0);
    const r = v.project_id ? rates.get(v.project_id) : undefined;
    const rate = v.kind === "me" ? r?.me : r?.b;
    if (rate) fees += rate * d;
    else { unpricedDays += d; const n = v.projects?.display_name ?? "Sites not linked to a job"; unpriced.set(n, (unpriced.get(n) ?? 0) + d); }
  }
  return { month: m, days, fees, clerks, unpricedDays, unpriced: [...unpriced].map(([name, days]) => ({ name, days })).sort((a, b) => b.days - a.days) };
}

/** The months after Xero's last full month that have planned days in the diary (up to two). */
export async function monthsToEstimate(db: SupabaseClient, lastXeroMonth: string | undefined) {
  const out: string[] = [];
  let m = lastXeroMonth ? nextMonth(`${lastXeroMonth}-01`) : new Date().toISOString().slice(0, 8) + "01";
  for (let k = 0; k < 2; k++, m = nextMonth(m)) {
    const { count } = await db.from("diary_visits").select("id", { count: "exact", head: true }).eq("side", "planned").gte("visit_date", m).lt("visit_date", nextMonth(m));
    if (count) out.push(m);
  }
  return out;
}
