-- Gmail sync: one timeline entry per email message (re-runs don't duplicate).
alter table chase_events add column gmail_message_id text;
create unique index chase_events_gmail_message on chase_events (invoice_id, gmail_message_id) where gmail_message_id is not null;
