-- Each month's totals as the diary works them out (Ronan, 18 Nov 2026): what was charged, paid to clerks and the profit
-- (salmon side), and the estimates from the grey (planned) side. Read on every diary read. Director only.
create table if not exists diary_month_totals (
  month date primary key,
  charged numeric,
  subcontractors numeric,
  profit numeric,
  planned_charged numeric,
  planned_subcontractors numeric,
  planned_profit numeric,
  planned_client_days numeric,
  planned_clerk_days numeric,
  read_at timestamptz not null default now()
);
alter table diary_month_totals enable row level security;
drop policy if exists director_read on diary_month_totals;
create policy director_read on diary_month_totals for select using (public.is_director());
