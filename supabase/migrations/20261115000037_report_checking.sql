-- Report checking in the dashboard (Ronan, 15 Nov 2026): every Word report a clerk uploads is found, checked by AI
-- (spelling fixed as tracked changes, photos made smaller, issues commented), queued red/orange/green for its checker,
-- and approved + sent from the checker's own email with the standard email. Timings for clerks and checkers.

create table reports (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text not null unique,          -- the Word file
  file_name text not null,
  folder_id text,                              -- its report folder (Diaries, M&E Diaries, Reports...)
  folder_name text,
  project_folder_id text,
  project_folder_name text,
  project_id uuid references projects (id) on delete set null,
  kind text check (kind in ('building', 'me')),
  clerk_id uuid references clerks (id) on delete set null,
  clerk_name text,                             -- as written in the report, when no clerk matched
  visit_date date,
  report_number text,
  uploaded_at timestamptz not null,            -- when the Word file appeared in Drive
  modified_at timestamptz,
  checker_id uuid references profiles (id) on delete set null,
  status text not null default 'new' check (status in ('new', 'checking', 'ready', 'approved', 'sent', 'done', 'failed', 'ignored')),
  ai_summary text,
  issues jsonb not null default '[]',          -- [{severity: high|medium|low, kind, text}]
  spelling_fixed int not null default 0,
  photos jsonb,                                -- {count, small, large, stretched, before_bytes, after_bytes}
  size_before bigint,
  size_after bigint,
  checked_revision text,                       -- Drive revision after the AI's changes
  text_snapshot text,                          -- the report's text, to spot paragraphs copied into the next one
  checked_at timestamptz,
  pdf_file_id text,
  approved_by uuid references profiles (id),
  approved_at timestamptz,
  sent_at timestamptz,
  sent_by uuid references profiles (id),
  sent_to text[],
  sent_cc text[],
  gmail_message_id text,
  done_at timestamptz,                         -- PDF found (made by hand) or sent from here
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reports_status on reports (status);
create index reports_project on reports (project_id);
alter table reports enable row level security;
create policy reports_staff on reports for all using (is_staff()) with check (is_staff());

-- one row: the standard email and the deadlines, editable by the team
create table report_settings (
  id int primary key default 1 check (id = 1),
  email_subject text not null default '{project} – Clerk of Works report {report_number} – {visit_date}',
  email_body text not null default E'Good afternoon,\n\nPlease find attached the Clerk of Works report for {project} following the visit on {visit_date}.\n\nAny questions, please let me know.\n\nKind regards,\n{sender_name}\nBeamore Management Ltd',
  clerk_days int not null default 1,           -- working days after the visit for the clerk to upload
  team_days int not null default 1,            -- working days after upload for the team to check and send
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into report_settings (id) values (1) on conflict do nothing;
alter table report_settings enable row level security;
create policy report_settings_staff on report_settings for all using (is_staff()) with check (is_staff());

-- each team member's own Gmail, to send reports from (only the send permission is asked for)
create table user_google (
  profile_id uuid primary key references profiles (id) on delete cascade,
  email text not null,
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  connected_at timestamptz not null default now()
);
alter table user_google enable row level security;  -- no policies: only the server (service role) reads tokens

-- who checks a project's reports
alter table projects add column report_checker_id uuid references profiles (id) on delete set null;
