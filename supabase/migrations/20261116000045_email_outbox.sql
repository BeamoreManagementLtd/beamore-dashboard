-- Emails the dashboard writes by itself (Ronan, 16 Nov 2026): instead of going into Gmail Drafts they wait on the
-- dashboard's "Emails to send" page, where someone reads them and presses Send (from their own Gmail), Save to Gmail
-- Drafts, Copy or Not needed. Insurance renewal reminders are sent automatically and kept here as a record.
create table if not exists email_outbox (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null,                -- info, portal-correction, renewal, insurance-renewal ...
  to_email text not null default '',
  cc text,
  subject text not null,
  body text not null,
  thread_id text,
  in_reply_to text,
  project_id uuid references projects(id) on delete cascade,
  clerk_id uuid references clerks(id) on delete cascade,
  ref text,                          -- what it's about, e.g. an upload id, so the same email isn't queued twice
  status text not null default 'waiting', -- waiting, sent, drafted, dismissed
  done_at timestamptz,
  done_by uuid references profiles(id) on delete set null,
  note text
);
create index if not exists email_outbox_waiting on email_outbox (status, created_at desc);
alter table email_outbox enable row level security;
create policy email_outbox_staff on email_outbox for all using (is_staff()) with check (is_staff());
