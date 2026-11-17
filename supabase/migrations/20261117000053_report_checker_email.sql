-- The checker for a job by email, for someone who hasn't signed in to the dashboard yet (Judy, from Anél's Diary TRACKER,
-- 17 Nov 2026). The report scan turns it into report_checker_id once that person has a login.
alter table projects add column if not exists report_checker_email text;
