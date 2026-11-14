-- Monthly sign-off: planned vs charged per project, and the draft Xero invoices prepared from it.

-- Days per project, kind and side for one month (grouped in the database: a month has well over 1,000 visit rows)
create function public.month_project_days(m date)
returns table (project_id uuid, kind visit_kind, side visit_side, days numeric)
language sql stable security invoker set search_path = public as $$
  select project_id, kind, side, sum(days) from diary_visits
  where visit_date >= m and visit_date < (m + interval '1 month')::date
  group by 1, 2, 3;
$$;

-- Draft invoices prepared for a month (director only)
create table invoice_drafts (
  id uuid primary key default gen_random_uuid(),
  month date not null,
  project_id uuid references projects (id),
  status text not null check (status in ('prepared', 'skipped', 'created', 'error')),
  invoice_number text,
  contact_name text,
  reference text,
  days_building numeric,
  days_me numeric,
  total_net numeric,
  lines jsonb,                 -- what the draft will say, for review
  payload jsonb,               -- exactly what is sent to Xero
  warnings text[] not null default '{}',
  note text,                   -- why skipped, or the Xero error
  xero_invoice_id text,
  created_at timestamptz not null default now()
);
create index on invoice_drafts (month);
alter table invoice_drafts enable row level security;
create policy director_all on invoice_drafts for all using (public.is_director()) with check (public.is_director());
