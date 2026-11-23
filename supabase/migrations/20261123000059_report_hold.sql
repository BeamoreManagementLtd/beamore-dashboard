-- "On hold: waiting for the clerk" (Ronan, 23 Nov 2026): a report someone has sent back to the clerk for changes can't
-- be sent until it's taken off hold. hold_at set = on hold.
alter table reports add column if not exists hold_by uuid references profiles(id) on delete set null;
alter table reports add column if not exists hold_at timestamptz;
alter table reports add column if not exists hold_reason text;
