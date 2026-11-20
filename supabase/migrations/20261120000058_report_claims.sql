-- Someone else checking a report for now (Ronan, 20 Nov 2026): "Andy K is checking this one" without changing the
-- allocated checker. Cleared when the report is sent or done, by "Stop checking", or after 2 hours (read as expired).
alter table reports add column if not exists claimed_by uuid references profiles(id) on delete set null;
alter table reports add column if not exists claimed_at timestamptz;
