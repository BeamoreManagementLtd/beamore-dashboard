-- Beamore dashboard: initial schema
-- Roles: 'director' sees everything; 'admin' sees operations and the overdue chase queue, never other finance.
-- Finance figures live in separate tables (project_finance, finance_snapshots, rates, clerk_costs) whose
-- row-level security only allows directors, so admin pages and API calls can't receive them.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- people & roles
create type app_role as enum ('director', 'admin');

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text,
  role app_role not null default 'admin',
  created_at timestamptz not null default now()
);

-- Only @beamore.co.uk Google accounts get a profile; everyone else is refused at sign-in.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if split_part(new.email, '@', 2) <> 'beamore.co.uk' then
    raise exception 'Only beamore.co.uk accounts can sign in';
  end if;
  insert into profiles (id, email, full_name, role)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name',
          case when new.email = 'ronan@beamore.co.uk' then 'director'::app_role else 'admin'::app_role end);
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid())
$$;
create or replace function public.is_director() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'director')
$$;

-- ---------------------------------------------------------------- clients & projects
create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,              -- Xero contact name is the standard (decision 11)
  xero_contact_id text unique,
  aliases text[] not null default '{}'    -- e.g. {'Motts'} for Mott MacDonald
);

create type project_stage as enum ('enquiry', 'pricing', 'sent', 'won_arranging', 'won_preparing', 'live', 'on_hold', 'lost', 'complete');

create table projects (
  id uuid primary key default gen_random_uuid(),
  number int not null unique,             -- 1073 in "St Aidans 1073" (decision 1)
  name text not null,                     -- "St Aidans"
  display_name text generated always as (name || ' ' || number) stored,
  client_id uuid references clients (id),
  stage project_stage not null default 'enquiry',
  site text,
  proposal_folder text,                   -- path under Cost Proposals
  diary_aliases text[] not null default '{}',  -- typed diary site names, e.g. {'StAidans','StAidans(Building)'} (decision 2)
  xero_invoice_prefixes text[] not null default '{}',
  agreed_days_building numeric,
  agreed_days_me numeric,
  visits_per_week numeric,
  start_date date,
  end_date date,
  owner_id uuid references profiles (id),
  next_action text,
  next_action_due date,
  with_whom text,
  extraction_confidence text,             -- High / Medium / Derived / Low from the register build
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Money for a project: director only
create table project_finance (
  project_id uuid primary key references projects (id) on delete cascade,
  quoted_fee numeric,
  charge_rate_building numeric,
  charge_rate_me numeric,
  pay_rate_building numeric,
  pay_rate_me numeric,
  updated_at timestamptz not null default now()
);

create table proposal_revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  revision text not null,                 -- 'Original', 'Rev A'...
  file_path text,
  file_date date,
  sent_date date,
  days_building numeric,
  days_me numeric,
  note text
);
create table proposal_revision_fees (     -- director only
  revision_id uuid primary key references proposal_revisions (id) on delete cascade,
  fee numeric
);

-- ---------------------------------------------------------------- clerks & compliance (decision 17)
create table clerks (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,              -- as written in the diary block
  email text,
  phone text,
  active boolean not null default true
);
create table clerk_compliance (
  clerk_id uuid primary key references clerks (id) on delete cascade,
  dbs_level text,                          -- Basic / Standard / Enhanced
  dbs_status text check (dbs_status in ('verified', 'in_progress', 'action_needed', 'none')),
  dbs_checked date,
  dbs_recheck date,
  dbs_update_service boolean,
  chartership_body text,                   -- MCIOB, ICWCI, RICS...
  chartership_grade text,
  chartership_number text,
  chartership_renewal date,
  ppe_notes text,
  onboarding_complete boolean not null default false,
  updated_at timestamptz not null default now()
);
create table clerk_evidence (              -- restricted: director only
  id uuid primary key default gen_random_uuid(),
  clerk_id uuid not null references clerks (id) on delete cascade,
  kind text not null,                       -- dbs_certificate, chartership_certificate...
  file_url text not null,
  uploaded_at timestamptz not null default now()
);
create table onboarding_items (
  id uuid primary key default gen_random_uuid(),
  clerk_id uuid not null references clerks (id) on delete cascade,
  item text not null,                       -- joining info sent, documents, system access, guidance, PPE requested/sent/received
  done_on date,
  owner_id uuid references profiles (id),
  due date
);

-- ---------------------------------------------------------------- diary (decisions 3, 4, 7, 8)
create type visit_kind as enum ('building', 'me');
create type visit_side as enum ('planned', 'charged');   -- grey / salmon

create table diary_visits (
  id uuid primary key default gen_random_uuid(),
  visit_date date not null,                 -- weekend rows keep their own date
  clerk_id uuid references clerks (id),
  project_id uuid references projects (id),
  site_as_typed text not null,
  kind visit_kind not null,
  side visit_side not null,
  days numeric not null default 0.5,        -- each slot is half a day
  source_sheet text,                        -- 'Diary 2026.xlsx / October'
  source_row int,
  imported_at timestamptz not null default now()
);
create index on diary_visits (project_id, visit_date);
create index on diary_visits (clerk_id, visit_date);
create table clerk_costs (                  -- director only: what Beamore pays per slot
  visit_id uuid primary key references diary_visits (id) on delete cascade,
  cost numeric not null
);
create table unmatched_diary_sites (
  site_as_typed text primary key,
  first_seen date,
  last_seen date,
  days numeric,
  resolved_project_id uuid references projects (id)
);

-- Monthly sign-off of planned vs charged before invoices are drafted (decision 6)
create table month_signoffs (
  month date primary key,                   -- first of month
  approved_by uuid references profiles (id),
  approved_at timestamptz,
  notes text
);

-- ---------------------------------------------------------------- absences (decision 5)
create table absences (
  id uuid primary key default gen_random_uuid(),
  clerk_id uuid not null references clerks (id),
  date_from date not null,
  date_to date not null,
  part_day text check (part_day in ('am', 'pm')),
  kind text not null default 'Holiday',
  status text not null default 'confirmed' check (status in ('provisional', 'confirmed', 'cancelled')),
  source text not null default 'dashboard' check (source in ('dashboard', 'diary', 'gmail')),
  synced_to_diary_at timestamptz,
  cover_owner_id uuid references profiles (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- invoices & chasing (decisions 12-14)
create table invoices (                      -- synced from Xero; amounts visible to admin for the chase queue
  id uuid primary key default gen_random_uuid(),
  xero_invoice_id text unique,
  number text not null unique,
  project_id uuid references projects (id),
  client_id uuid references clients (id),
  reference text,
  issued date,
  due date,
  total numeric,
  amount_due numeric,
  status text,
  days_building numeric,
  days_me numeric,
  synced_at timestamptz not null default now()
);
create table chase_state (
  invoice_id uuid primary key references invoices (id) on delete cascade,
  status text not null default 'new' check (status in ('new', 'our_move', 'queried', 'promised', 'waiting')),
  with_whom text,
  owner_id uuid references profiles (id),
  next_action text,
  next_action_due date,
  promised_date date,
  updated_at timestamptz not null default now()
);
create table chase_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices (id) on delete cascade,
  happened_at timestamptz not null,
  source text not null check (source in ('xero', 'gmail', 'team')),
  kind text not null,
  who text,
  body text,
  gmail_thread_id text,
  created_by uuid references profiles (id)
);
create table project_contacts (              -- chaser recipients per project from the diary's Invoice emails tab
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id) on delete cascade,
  name text,
  email text not null,
  purpose text not null default 'invoices'
);

-- ---------------------------------------------------------------- reports
create table report_queue (                  -- from the "Beamore Reports Ready To Check" sheet
  id uuid primary key default gen_random_uuid(),
  project_name text not null,
  project_id uuid references projects (id),
  report_name text not null,
  folder text,
  report_date date,
  due date,
  checker text,
  drive_file_id text,
  scanned_at timestamptz not null
);
create table report_log (                    -- from the Report Turnaround Dashboard
  id uuid primary key default gen_random_uuid(),
  clerk_name text,
  project_name text,
  visit_date date,
  report_date date,
  working_days numeric,
  status text,
  reason text,
  checker text,
  drive_file_id text unique
);

-- ---------------------------------------------------------------- team
create table tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references profiles (id),
  title text not null,
  kind text,
  due date,
  link text,
  source_table text,
  source_id uuid,
  done_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- finance snapshots (director only)
create table finance_snapshots (
  id uuid primary key default gen_random_uuid(),
  taken_at timestamptz not null default now(),
  period text not null,                      -- '2026-10' or 'FY2026-YTD'
  sales numeric, subcontractors numeric, cogs numeric, net_profit numeric,
  cash numeric, receivables numeric, receivables_overdue numeric
);
create table rates (                         -- the diary's Rates tab is master (decision 16)
  site_as_typed text primary key,
  charge numeric,
  pay numeric,
  synced_at timestamptz not null default now()
);

create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null,                      -- xero, diary, report_queue, report_log, gmail, register
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  message text
);

-- ---------------------------------------------------------------- row-level security
do $$
declare t text;
begin
  -- staff (director + admin) can read and write operational tables
  foreach t in array array['clients','projects','proposal_revisions','clerks','clerk_compliance','onboarding_items',
                           'diary_visits','unmatched_diary_sites','absences','invoices','chase_state','chase_events',
                           'project_contacts','report_queue','report_log','tasks','sync_runs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy staff_all on %I for all using (public.is_staff()) with check (public.is_staff())', t);
  end loop;
  -- director only
  foreach t in array array['project_finance','proposal_revision_fees','clerk_evidence','clerk_costs','finance_snapshots','rates']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy director_all on %I for all using (public.is_director()) with check (public.is_director())', t);
  end loop;
end $$;

alter table profiles enable row level security;
create policy read_self_or_staff on profiles for select using (public.is_staff());
create policy director_manages_roles on profiles for update using (public.is_director());

-- month sign-off (which triggers draft Xero invoices): staff can see it, only the director can approve
alter table month_signoffs enable row level security;
create policy staff_read_signoff on month_signoffs for select using (public.is_staff());
create policy director_signoff on month_signoffs for all using (public.is_director()) with check (public.is_director());
