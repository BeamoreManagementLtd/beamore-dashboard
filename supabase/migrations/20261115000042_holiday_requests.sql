-- Holidays from clerks' emails (Ronan, 15 Nov 2026): "when someone sends an email about holidays, we need to be able
-- to put the holiday in to the diary and then put a to-do list to get cover for that person's holidays".
-- An email that looks like a holiday notice is held here with the dates the AI read from it, until someone in the
-- office adds it (it then becomes an absence, goes into the diary and a cover to-do is made) or dismisses it.
create table holiday_requests (
  id uuid primary key default gen_random_uuid(),
  clerk_id uuid references clerks (id) on delete cascade,
  gmail_message_id text not null unique,
  gmail_thread_id text,
  received_at timestamptz not null,
  from_email text,
  subject text,
  excerpt text,
  date_from date,
  date_to date,
  part_day text check (part_day in ('am', 'pm')),
  kind text not null default 'Holiday',
  ai_note text,
  status text not null default 'pending' check (status in ('pending', 'added', 'dismissed')),
  absence_id uuid references absences (id) on delete set null,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on holiday_requests (status, received_at);
alter table holiday_requests enable row level security;
create policy holiday_requests_staff on holiday_requests for all using (is_staff()) with check (is_staff());

-- the diary write for a holiday, and the cover to-do made for it
alter table absences add column if not exists diary_state text check (diary_state in ('waiting', 'written', 'needs_review'));
alter table absences add column if not exists diary_note text;
alter table absences add column if not exists cover_task_id uuid references tasks (id) on delete set null;
