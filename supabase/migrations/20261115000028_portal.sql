-- Clerk portal (portal.beamore.co.uk), rebuilt inside the dashboard. Ronan, 15 Nov 2026.
-- Clerks sign in with their @beamore.co.uk Google account, as before. Only people on staff_emails get a dashboard
-- profile; everyone else with a Beamore account can only reach their own portal pages (which use the service role
-- after checking the signed-in email against clerks.email). Every upload is accepted straight away and filed in the
-- clerk's own Personnel folder; checks and AI reading happen afterwards.

-- ---------------------------------------------------------------- who gets the dashboard
create table staff_emails (email text primary key, role app_role not null default 'admin', note text);
alter table staff_emails enable row level security;
create policy director_all on staff_emails for all using (public.is_director()) with check (public.is_director());
insert into staff_emails (email, role, note) values
  ('ronan@beamore.co.uk', 'director', 'Owner'),
  ('judy@beamore.co.uk', 'admin', 'Admin (from the old portal)');

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare r app_role;
begin
  if split_part(lower(new.email), '@', 2) <> 'beamore.co.uk' then
    raise exception 'Only beamore.co.uk accounts can sign in';
  end if;
  select role into r from staff_emails where email = lower(new.email);
  if r is not null then   -- staff: dashboard profile. Clerks get no profile, so is_staff() is false for them.
    insert into profiles (id, email, full_name, role)
    values (new.id, lower(new.email), new.raw_user_meta_data ->> 'full_name', r);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- portal access per clerk (old "Users" tab)
alter table clerks add column portal_access boolean not null default false;    -- may sign in to the portal
alter table clerks add column invoice_upload boolean not null default true;    -- may upload their own invoices
alter table clerks add column billing text;                                    -- Direct / Agency / Unconfirmed...
alter table clerks add column invoices_paused boolean not null default false;  -- not expected to invoice for now
alter table clerks add column portal_role text not null default 'clerk' check (portal_role in ('clerk', 'admin', 'accounts'));

-- ---------------------------------------------------------------- every upload (invoices, insurance, qualifications)
create table portal_uploads (
  id uuid primary key default gen_random_uuid(),
  receipt text not null unique,             -- shown to the clerk; old portal receipts kept as they were
  clerk_id uuid references clerks (id) on delete set null,
  email text not null,                      -- who uploaded (or whose company invoice, for admin uploads)
  kind text not null check (kind in ('invoice', 'insurance', 'qualification', 'company_invoice')),
  doc_type text,                            -- qualification type (CSCS card, MCIOB...) or insurance type once read
  file_name text,
  mime text,
  bytes integer,
  sha256 text,
  storage_path text,                        -- temporary copy in Supabase storage until filed in Drive
  drive_file_id text,                       -- the filed copy in the clerk's Personnel folder
  drive_folder_id text,
  received_at timestamptz not null default now(),
  status text not null default 'received',  -- received, filed, checked, accepted, needs_correction, needs_beamore, deleted
  scan_state text,                          -- pending, clean, suspicious
  scan_note text,
  ai_state text,                            -- pending, done, failed, skipped
  ai_result jsonb,                          -- what the AI read off the document
  issues text[] not null default '{}',      -- plain-English problems for Ronan / the clerk
  period text,                              -- invoices: month invoiced, YYYY-MM
  deleted_at timestamptz,
  deleted_by text,
  deleted_reason text,
  correction_drafted_at timestamptz,        -- Gmail draft to the clerk saved (never sent automatically)
  resolved_at timestamptz,
  resolved_by text,
  source text not null default 'portal',    -- portal (new) / legacy (imported from the old Google portal)
  legacy jsonb                              -- the old register rows for this receipt, verbatim
);
create index on portal_uploads (clerk_id);
create index on portal_uploads (kind, status);

-- ---------------------------------------------------------------- insurance read off certificates
create table insurance_policies (
  id uuid primary key default gen_random_uuid(),
  upload_id uuid references portal_uploads (id) on delete set null,
  clerk_id uuid references clerks (id) on delete cascade,
  type text not null,                       -- PI, PL, EL, other
  description text,
  insurer text,
  insured_name text,
  policy_number text,
  cover_pence bigint,
  currency text default 'GBP',
  starts date,
  expires date,
  evidence jsonb,
  checked_at timestamptz,
  checked_by text,                          -- 'AI', a person, or 'old portal'
  source text not null default 'portal',
  created_at timestamptz not null default now()
);
create index on insurance_policies (clerk_id, type, expires);

-- ---------------------------------------------------------------- invoices: what was checked, and monthly expectations
create table portal_invoice_checks (
  upload_id uuid primary key references portal_uploads (id) on delete cascade,
  supplier text,                            -- company or person invoicing
  invoice_number text,
  invoice_date date,
  period text,
  net_pence bigint, vat_pence bigint, gross_pence bigint,
  vat_checked boolean, cis boolean,
  diary_days numeric,                       -- days the diary shows for this clerk in the period
  checked_at timestamptz, checked_by text
);
create table portal_expectations (
  period text not null,                     -- YYYY-MM
  clerk_id uuid not null references clerks (id) on delete cascade,
  expected boolean not null,                -- false = "not working this month"
  note text,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (period, clerk_id)
);

-- ---------------------------------------------------------------- the companies each clerk invoices through (Xero contacts)
create table clerk_companies (
  id uuid primary key default gen_random_uuid(),
  legacy_id text unique,
  clerk_id uuid references clerks (id) on delete cascade,
  email text,
  company_name text not null,
  xero_contact_id text,
  xero_tenant_id text,
  relationship text,
  status text,                              -- active / revoked ...
  evidence text,
  created_at timestamptz, created_by text, updated_at timestamptz, updated_by text
);
create index on clerk_companies (clerk_id);

-- ---------------------------------------------------------------- history
create table portal_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text,
  action text not null,
  detail jsonb
);
-- Every row of the old Google register, verbatim, so nothing from the old portal is ever lost.
create table portal_legacy_rows (
  sheet text not null,
  row_number integer not null,
  data jsonb not null,
  imported_at timestamptz not null default now(),
  primary key (sheet, row_number)
);

do $$
declare t text;
begin
  foreach t in array array['portal_uploads','insurance_policies','portal_invoice_checks','portal_expectations','clerk_companies','portal_audit','portal_legacy_rows'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy staff_all on %I for all using (public.is_staff()) with check (public.is_staff())', t);
  end loop;
end $$;

-- Temporary home for uploads until they're filed in Drive (private; only the server reads it).
insert into storage.buckets (id, name, public, file_size_limit) values ('portal-uploads', 'portal-uploads', false, 26214400)
on conflict (id) do nothing;
