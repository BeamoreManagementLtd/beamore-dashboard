-- A clerk checks a draft report in the portal before putting it in Google Drive (Ronan, 18 Nov 2026): the AI feedback
-- straight away, so they can put things right first. The draft never goes to Drive or the office; the file itself is
-- removed from storage once it has been checked, and only the feedback is kept.
create table report_prechecks (
  id uuid primary key default gen_random_uuid(),
  clerk_id uuid not null references clerks (id) on delete cascade,
  project_id uuid references projects (id) on delete set null,
  kind text not null default 'building' check (kind in ('building', 'me')),
  file_name text not null,
  storage_path text,
  bytes bigint,
  status text not null default 'uploading' check (status in ('uploading', 'waiting', 'checking', 'done', 'failed')),
  error text,
  score numeric,
  summary text,
  issues jsonb,
  clerk_points jsonb,
  fixes jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  checked_at timestamptz
);
create index report_prechecks_clerk on report_prechecks (clerk_id, created_at desc);
create index report_prechecks_waiting on report_prechecks (status) where status in ('waiting', 'checking');
alter table report_prechecks enable row level security;
-- directors can see them on the dashboard; clerks reach theirs through the portal (service role, own rows only)
create policy report_prechecks_director_read on report_prechecks for select using (is_director());

insert into storage.buckets (id, name, public, file_size_limit)
values ('report-prechecks', 'report-prechecks', false, 52428800)
on conflict (id) do nothing;
