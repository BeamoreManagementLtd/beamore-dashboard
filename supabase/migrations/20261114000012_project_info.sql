-- Tracking project information from clients (drawings, programme, site contacts, PO…) and a project log.
create table project_info (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  item text not null,
  requested_on date,
  received_on date,
  note text,
  created_at timestamptz not null default now()
);
create table project_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  happened_at timestamptz not null default now(),
  source text not null default 'team' check (source in ('team', 'gmail', 'dashboard')),
  kind text not null,
  who text,
  body text,
  created_by uuid references profiles (id)
);
create index on project_events (project_id, happened_at);
alter table project_info enable row level security;
alter table project_events enable row level security;
create policy staff_all on project_info for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on project_events for all using (public.is_staff()) with check (public.is_staff());
