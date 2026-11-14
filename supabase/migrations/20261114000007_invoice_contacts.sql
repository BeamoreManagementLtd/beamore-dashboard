-- Who invoices and chasers go to, from the diary's "Invoice emails" tab (decision 14), per project or per client ("General").
create table invoice_contacts (
  id uuid primary key default gen_random_uuid(),
  label text not null,               -- as written in the diary, e.g. "Mott MacDonald - Sheffield - St Peters Batley"
  project_id uuid references projects (id) on delete cascade,
  client_id uuid references clients (id) on delete cascade,
  to_emails text[] not null,
  cc_emails text[] not null default '{}',
  notes text,                        -- PO / project numbers noted in the diary
  synced_at timestamptz not null default now()
);
alter table invoice_contacts enable row level security;
create policy staff_all on invoice_contacts for all using (public.is_staff()) with check (public.is_staff());
