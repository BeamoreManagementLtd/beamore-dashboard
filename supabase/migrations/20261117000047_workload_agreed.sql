-- Work agreed verbally (Ronan, 17 Nov 2026: "Andy Collier does Airbus once a week"): a clerk, a job (or a label for
-- work that isn't on the dashboard), so many days a week or a month, from a date until a date or further notice.
-- Counts on the clerk's Workload row; for a job with a cost schedule it replaces the schedule's days in those months.
create table workload_agreed (
  id uuid primary key default gen_random_uuid(),
  clerk_id uuid not null references clerks (id) on delete cascade,
  project_id uuid references projects (id) on delete cascade,
  label text,                                   -- when it isn't a job on the dashboard
  kind visit_kind not null default 'building',
  days numeric not null check (days > 0 and days <= 31),
  per text not null check (per in ('week', 'month')),
  date_from date not null,
  date_to date,                                 -- null = until further notice
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (project_id is not null or coalesce(label, '') <> ''),
  check (date_to is null or date_to >= date_from)
);
create index on workload_agreed (clerk_id);
create index on workload_agreed (project_id);
alter table workload_agreed enable row level security;
create policy staff_all on workload_agreed for all using (public.is_staff()) with check (public.is_staff());

-- L2 "Reports" on a project only looked at the old report tracker, so reports that came in through the dashboard's
-- report checking (the reports table) didn't count and live jobs showed amber with "last report none yet".
create or replace view project_report_summary with (security_invoker = on) as
select project_id, max(last_report) as last_report, sum(n) as reports
from (
  select project_id, max(report_date) as last_report, count(*) as n from report_log where project_id is not null group by project_id
  union all
  select project_id, null::date, count(*) from report_queue where project_id is not null group by project_id
  union all
  select project_id, max(coalesce(visit_date, uploaded_at::date, created_at::date)), count(*) from reports
  where project_id is not null and status is distinct from 'deleted' group by project_id
) x
group by project_id;
