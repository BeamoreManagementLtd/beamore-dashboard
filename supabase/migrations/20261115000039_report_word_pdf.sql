-- PDFs made with Word, not Google (Ronan, 15 Nov 2026: Google spoils the layout). On "Approve and send" the email is
-- kept here; a helper on the office PC opens the report in Word, saves the PDF next to it (Google Drive for desktop
-- uploads it), and the dashboard then sends it from the checker's email.
alter table reports add column main_folder text;             -- Schools / Others: with the folder names, where it is on the PC
alter table reports add column pending_email jsonb;          -- {to, cc, subject, body, by, by_name} while waiting for the PDF
alter table reports add column pdf_name text;                -- the PDF's file name
alter table reports add column pdf_requested_at timestamptz;
alter table reports add column pdf_made_at timestamptz;      -- the helper says it has saved the PDF
-- 'sending': claimed by one run while the email goes, so it can't be sent twice
alter table reports drop constraint reports_status_check;
alter table reports add constraint reports_status_check check (status in ('new', 'checking', 'ready', 'approved', 'sending', 'sent', 'done', 'failed', 'ignored'));
