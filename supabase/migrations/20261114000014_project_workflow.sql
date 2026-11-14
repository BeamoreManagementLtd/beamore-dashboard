-- Project workflow: the facts a step needs that weren't stored yet, and steps ticked by hand.
alter table projects add column clerk_id uuid references clerks (id);
alter table projects add column clerk_status text check (clerk_status in ('have', 'finding'));
alter table projects add column po_number text;
alter table projects add column drive_folder_id text;
alter table projects add column lost_reason text;

create table project_steps (
  project_id uuid not null references projects (id) on delete cascade,
  step text not null,                     -- 'P3', 'S4', 'X2'… (src/lib/workflow.ts)
  done_at timestamptz not null default now(),
  done_by text,
  note text,                              -- X2: 'finished' / 'paused' / 'going'
  primary key (project_id, step)
);
alter table project_steps enable row level security;
create policy staff_all on project_steps for all using (public.is_staff()) with check (public.is_staff());
