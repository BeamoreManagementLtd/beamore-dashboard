-- Workload page (Ronan, 17 Nov 2026): planned days per clerk per month from the cost schedules, against the working
-- days each clerk has, building clerks of works and M&E clerks of works.

-- how many days a week the clerk works for us (5 = full time); holidays come off on top
alter table clerks add column if not exists days_per_week numeric not null default 5 check (days_per_week > 0 and days_per_week <= 7);

-- witnessing / commissioning days, the part of building / me that the cost schedule lists as witnessing
alter table project_planned_months add column if not exists building_witness numeric not null default 0;
alter table project_planned_months add column if not exists me_witness numeric not null default 0;

-- a month changed by hand on the Workload page (a job slipped); kept over the cost schedule until cleared
create table if not exists workload_overrides (
  project_id uuid not null references projects (id) on delete cascade,
  month date not null,
  kind visit_kind not null,
  days numeric not null check (days >= 0),
  note text,
  updated_by uuid references profiles (id),
  updated_at timestamptz not null default now(),
  primary key (project_id, month, kind)
);
alter table workload_overrides enable row level security;
create policy workload_overrides_staff on workload_overrides for all using (public.is_staff()) with check (public.is_staff());

-- Days each clerk is in the diary per month: each date counts once (a full day if both halves are filled, half if
-- one), whatever the number of sites, so a busy day isn't counted twice. Charged and booked (planned) both count.
create or replace function public.clerk_diary_days(d_from date, d_to date)
returns table (clerk_id uuid, kind visit_kind, month date, days numeric)
language sql stable security invoker set search_path = public as $$
  select clerk_id, kind, date_trunc('month', visit_date)::date, sum(least(1, d))
  from (
    select clerk_id, kind, visit_date,
           greatest(coalesce(sum(days) filter (where side = 'charged'), 0), coalesce(sum(days) filter (where side = 'planned'), 0)) as d
    from diary_visits
    where clerk_id is not null and visit_date >= d_from and visit_date < d_to
    group by clerk_id, kind, visit_date
  ) x
  group by 1, 2, 3;
$$;

-- specialists in the cost schedule (architect, structural / civil / fire engineer, facades): not clerk of works days
alter table project_planned_months add column if not exists other numeric not null default 0;
-- a fresh read of every cost schedule with the new split
update projects set plan_file_modified = null where plan_file_id is not null;
