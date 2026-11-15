-- "Ask the dashboard" (Ronan, 15 Nov 2026): every question and action is logged; anything outside Beamore work, or a
-- bigger action asked for by staff, waits for Ronan's approval.
create table ai_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid references profiles (id) on delete set null,
  question text,
  actions jsonb not null default '[]'   -- what it changed, e.g. [{"tool":"add_task","input":{...},"result":"..."}]
);
create index on ai_log (user_id, at);
create table ai_requests (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  requested_by uuid references profiles (id) on delete set null,
  requester_name text,
  kind text not null check (kind in ('off_topic', 'action', 'over_limit')),
  summary text not null,                -- what they want, in plain words
  question text,                        -- the original question
  payload jsonb,                        -- for an action: {"tool": ..., "input": {...}}
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  decided_at timestamptz,
  answer text                           -- the result once approved
);
create index on ai_requests (status, at);
alter table ai_log enable row level security;
alter table ai_requests enable row level security;
-- staff see their own log and requests; Ronan sees and decides all of them
create policy own_or_director on ai_log for select using (user_id = auth.uid() or public.is_director());
create policy own_insert on ai_log for insert with check (user_id = auth.uid());
create policy own_or_director on ai_requests for select using (requested_by = auth.uid() or public.is_director());
create policy own_insert on ai_requests for insert with check (requested_by = auth.uid());
create policy director_update on ai_requests for update using (public.is_director()) with check (public.is_director());
