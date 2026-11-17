-- The client's answers, not just a tick (Ronan, 17 Nov 2026: the clerk needs the DfE project manager, contacts etc.).
-- value: what the client gave (names, emails, phone numbers, numbers, links); value_from: email (read from their reply,
-- checked by the team) or manual. Shared with the job's clerks (no fees or invoicing details) by email, on the portal and
-- as a "Project information" Google Doc in the project folder.
alter table project_info add column if not exists value text;
alter table project_info add column if not exists value_from text;
alter table project_info add column if not exists value_at timestamptz;
alter table projects add column if not exists info_doc_id text;            -- the "Project information" Google Doc
alter table projects add column if not exists info_shared jsonb;           -- { hash, at, to: [clerk ids] } of the last email to the clerks
