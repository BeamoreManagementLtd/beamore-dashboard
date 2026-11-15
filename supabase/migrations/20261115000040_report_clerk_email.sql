-- The email to the clerk about their report (Ronan, 15 Nov 2026): drafted by the dashboard, edited if wanted, and sent
-- by the checker from their own email when they click Send.
alter table reports add column clerk_email_sent_at timestamptz;
alter table reports add column clerk_email_sent_by uuid references profiles (id);
