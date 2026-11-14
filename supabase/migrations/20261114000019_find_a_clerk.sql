-- Find a clerk (workflow 3): what the job needs and who we've approached.
alter table projects add column clerk_needed text;   -- C1: type of clerk and anything else (building, M&E, DfE CoW…)
create table clerk_candidates (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  clerk_id uuid references clerks (id),                -- null for someone new to Beamore
  name text not null,
  status text not null default 'approached' check (status in ('approached', 'interested', 'interviewed', 'references', 'declined', 'appointed')),
  note text,
  updated_at timestamptz not null default now()
);
create index on clerk_candidates (project_id);
alter table clerk_candidates enable row level security;
create policy staff_all on clerk_candidates for all using (public.is_staff()) with check (public.is_staff());
