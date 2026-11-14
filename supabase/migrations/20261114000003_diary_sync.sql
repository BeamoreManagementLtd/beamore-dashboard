-- Google Drive connection (reads Diary 2026.xlsx) and diary summaries.

create table google_connection (
  id int primary key default 1 check (id = 1),
  email text,
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  diary_file_id text,
  diary_modified_time text,              -- Drive's modifiedTime when the diary was last read
  connected_by uuid references profiles (id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table google_connection enable row level security;  -- service role only

create function public.google_connection_status()
returns table (email text, connected_at timestamptz, diary_modified_time text)
language sql stable security definer set search_path = public as $$
  select email, connected_at, diary_modified_time from google_connection where public.is_director();
$$;

-- One clerk however the diary spells them ("Andy Marris" / "Andrew Marris")
alter table clerks add column name_key text unique;

-- Days per project from the diary (respects the caller's row-level security)
create view project_diary_days with (security_invoker = true) as
select
  project_id,
  sum(days) filter (where side = 'charged') as charged_to_date,
  sum(days) filter (where side = 'charged' and kind = 'building') as charged_building,
  sum(days) filter (where side = 'charged' and kind = 'me') as charged_me,
  sum(days) filter (where side = 'charged' and date_trunc('month', visit_date) = date_trunc('month', current_date)) as charged_this_month,
  sum(days) filter (where side = 'planned' and date_trunc('month', visit_date) = date_trunc('month', current_date)) as planned_this_month,
  max(visit_date) filter (where side = 'charged') as last_visit
from diary_visits
where project_id is not null
group by project_id;

-- Days per clerk this month
create view clerk_month_days with (security_invoker = true) as
select
  clerk_id,
  sum(days) filter (where side = 'charged') as charged,
  sum(days) filter (where side = 'planned') as planned,
  count(distinct project_id) as sites
from diary_visits
where date_trunc('month', visit_date) = date_trunc('month', current_date)
group by clerk_id;
