-- Planned days per month from the project's latest cost sheet in Cost Proposals (Ronan always uses the latest).
create table project_planned_months (
  project_id uuid not null references projects (id) on delete cascade,
  month date not null,
  building numeric not null default 0,
  me numeric not null default 0,
  primary key (project_id, month)
);
alter table project_planned_months enable row level security;
create policy staff_read on project_planned_months for select using (public.is_staff());
alter table projects add column proposal_folder_id text;      -- its folder under Cost Proposals/<Client>/
alter table projects add column plan_file text;               -- the cost sheet the plan came from
alter table projects add column plan_file_id text;
alter table projects add column plan_file_modified timestamptz;
