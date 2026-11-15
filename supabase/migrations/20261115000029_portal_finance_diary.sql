-- Clerk portal, part 2 (Ronan, 15 Nov 2026).
-- 1. Who may see financial details (their Xero invoice and payment history, invoice amounts). People who invoice through
--    their own company can; subcontractors working through someone else's company (e.g. Mark Prickett via Amrin
--    Resources) can't.
alter table clerks add column finance_visible boolean not null default false;
update clerks c set finance_visible = true
where exists (select 1 from clerk_companies k where k.clerk_id = c.id and k.relationship = 'Direct company' and k.status = 'Enabled');

-- Company links: 'Own company' (the clerk's own business: sees its finances) or 'Works through' (an agency or main
-- contractor they work for: never sees its finances). The old portal's names are kept as they were.
alter table clerk_companies add column kind text not null default 'own' check (kind in ('own', 'works_through'));
update clerk_companies set kind = 'works_through' where relationship = 'External company';
update clerk_companies set kind = 'works_through', status = 'Enabled', relationship = 'Works through'
where company_name ilike 'Amrin Resources%' and email ilike 'mark.prickett@%';

-- 2. Invoices written into the salmon (charged) side of the diary.
alter table portal_uploads add column diary_state text;   -- waiting, written, needs_review, not_applicable
alter table portal_uploads add column diary_note text;
create table portal_diary_cells (
  id bigserial primary key,
  upload_id uuid not null references portal_uploads (id) on delete cascade,
  sheet text not null,
  cell text not null,
  value text not null,
  work_date date not null,       -- the day the work was done
  diary_date date not null,      -- the row it went in (a 4th half-day goes in the nearest free 3rd slot)
  written_at timestamptz not null default now(),
  revision_after text,           -- Drive file version after the write
  still_there_at timestamptz,    -- last time the hourly diary sync saw the value still in place
  unique (sheet, cell)
);
-- How each clerk words a site on their invoices -> the exact name used in the diary (learnt once, then reused).
create table site_aliases (
  id bigserial primary key,
  clerk_id uuid references clerks (id) on delete cascade,   -- null = applies to everyone
  wording text not null,
  site_as_typed text not null,
  created_at timestamptz not null default now(),
  created_by text,
  unique (clerk_id, wording)
);
alter table portal_diary_cells enable row level security;
alter table site_aliases enable row level security;
create policy staff_all on portal_diary_cells for all using (public.is_staff()) with check (public.is_staff());
create policy staff_all on site_aliases for all using (public.is_staff()) with check (public.is_staff());
