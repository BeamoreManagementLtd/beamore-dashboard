-- What the office has asked a clerk to do better from next week (Ronan, 23 Nov 2026), kept with the job so it shows on
-- the job's following reports until it's done: whoever checks next week sees it was already asked, and pushes back.
create table if not exists report_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  project_folder_name text,
  kind text not null default 'building',
  clerk_id uuid references clerks(id) on delete set null,
  asked_on_report uuid references reports(id) on delete set null,
  text text not null,
  asked_by uuid references profiles(id) on delete set null,
  asked_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'done', 'dropped')),
  missed jsonb not null default '[]',
  resolved_by uuid references profiles(id) on delete set null,
  resolved_at timestamptz,
  resolved_on_report uuid references reports(id) on delete set null
);
create index if not exists report_requests_job on report_requests (project_id, kind, status);
alter table report_requests enable row level security;
