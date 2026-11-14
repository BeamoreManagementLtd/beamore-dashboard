-- Reports sync: the Ready To Check sheet → report_queue, the Report Turnaround workbook's Report Log → report_log.

-- Which version of each Drive file was last read (so hourly checks skip unchanged files)
create table sync_files (
  key text primary key,            -- 'report_queue', 'report_log'
  file_id text,
  modified_time text,
  read_at timestamptz
);
alter table sync_files enable row level security;  -- service role only

alter table report_log add column report_name text;
alter table report_log add column checked_at timestamptz;
alter table report_log add column project_id uuid references projects (id);
alter table report_log add column clerk_id uuid references clerks (id);
create index on report_log (report_date);

-- Turnaround per clerk per month, the same measures as the Report Turnaround Dashboard
create view report_turnaround with (security_invoker = true) as
select
  date_trunc('month', report_date)::date as month,
  coalesce(c.name, l.clerk_name) as clerk,
  count(*) as reports,
  round(avg(working_days), 1) as avg_days,
  count(*) filter (where working_days > 2) as over_two_days,
  count(*) filter (where status = 'Review Required') as review_required
from report_log l left join clerks c on c.id = l.clerk_id
where report_date is not null
group by 1, 2;
