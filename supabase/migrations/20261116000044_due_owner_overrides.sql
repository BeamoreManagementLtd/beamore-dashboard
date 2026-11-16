-- Moving a due-list item to someone else (Ronan, 16 Nov 2026): most items are worked out from live data each time, so
-- who they've been moved to is kept here by the item's key. owner_name is a first name or "Ronan or Judy" (joint).
create table if not exists due_owner_overrides (
  due_key text primary key,
  owner_id uuid references profiles(id) on delete set null,
  owner_name text,
  set_by uuid references profiles(id) on delete set null,
  set_at timestamptz not null default now()
);
alter table due_owner_overrides enable row level security;
create policy due_owner_overrides_staff on due_owner_overrides for all using (is_staff()) with check (is_staff());
