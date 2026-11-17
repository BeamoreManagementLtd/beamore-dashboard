-- Report tracker (Ronan, 17 Nov 2026: replaces Anél's "Diary TRACKER" spreadsheet: "we don't seem to have any way of
-- knowing that the clerk of works missed uploading a report"). Every report file that lands in a job's report folders,
-- Word or PDF (some clerks upload PDFs only), so the dashboard can tell which weeks have a report and which don't.
create table if not exists report_files (
  drive_file_id text primary key,
  name text not null,
  file_type text not null,                 -- docx, doc, pdf
  folder_id text, folder_name text,
  project_folder_id text, project_folder_name text,
  project_id uuid references projects(id) on delete set null,
  kind text not null default 'building',   -- building / me
  monthly boolean not null default false,
  created_time timestamptz not null,       -- when it arrived in Drive
  report_date date,                        -- the visit / report date from its name, else from the checked report
  week date,                               -- the Monday of the week it reports on
  seen_at timestamptz not null default now()
);
create index if not exists report_files_project_week on report_files (project_id, kind, week);
alter table report_files enable row level security;
drop policy if exists "staff read report_files" on report_files;
create policy "staff read report_files" on report_files for select to authenticated using (true);

-- a job whose reports are kept somewhere the dashboard can't see (e.g. FieldView): shown as such, never "missing"
alter table projects add column if not exists reports_elsewhere text;
-- chasing a missing report: a gentle email to the clerk, once; off until Ronan switches it on
alter table report_settings add column if not exists chase_missing boolean not null default false;
