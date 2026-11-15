-- Todoist link (Ronan, 15 Nov 2026): a "Beamore" project in Ronan's Todoist.
--   "My tasks" section <-> the dashboard's tasks for Ronan, both ways (add on either side, tick off on either side).
--   "From the dashboard" section: Ronan's due list mirrored one way; items close in Todoist when they're dealt with.
create table todoist_state (
  id int primary key default 1 check (id = 1),
  sync_token text,
  project_id text,
  tasks_section_id text,
  due_section_id text,
  last_run timestamptz
);
alter table tasks add column todoist_id text unique;
create table todoist_due_items (
  due_key text primary key,       -- the due list item's key, e.g. "xero-drafts"
  todoist_id text not null,
  title text,
  ticked_in_todoist_at timestamptz
);
alter table todoist_state enable row level security;
alter table todoist_due_items enable row level security;
create policy director_all on todoist_state for all using (public.is_director()) with check (public.is_director());
create policy director_all on todoist_due_items for all using (public.is_director()) with check (public.is_director());
