-- Draft sales invoices in Xero (approved or sent ones are in invoices). Replaced on every Xero sync.
create table xero_draft_invoices (
  xero_invoice_id text primary key,
  number text,
  contact text,
  reference text,
  issued date,
  subtotal numeric,
  project_id uuid references projects (id) on delete set null,
  synced_at timestamptz not null default now()
);
create index on xero_draft_invoices (project_id);
alter table xero_draft_invoices enable row level security;
create policy staff_read on xero_draft_invoices for select using (public.is_staff());

-- Xero contacts whose drafts are held on purpose (listed, never nagged about). Portakabin: Ronan, 15 Nov 2026.
create table held_draft_contacts (contact text primary key, note text);
alter table held_draft_contacts enable row level security;
create policy staff_all on held_draft_contacts for all using (public.is_staff()) with check (public.is_staff());
insert into held_draft_contacts (contact, note) values ('Portakabin', 'Held on purpose (Ronan, 15 Nov 2026)');
