-- Individual draft invoices held on purpose (listed on the project, never nagged about). Ronan, 15 Nov 2026.
create table held_draft_invoices (number text primary key, note text);
alter table held_draft_invoices enable row level security;
create policy staff_all on held_draft_invoices for all using (public.is_staff()) with check (public.is_staff());
insert into held_draft_invoices (number, note) values
  ('GLDS-918', 'Held on purpose (Ronan, 15 Nov 2026)'), ('GLDS-941', 'Held on purpose (Ronan, 15 Nov 2026)'),
  ('GLDS-934', 'Held on purpose (Ronan, 15 Nov 2026)'), ('TT-001', 'Held on purpose (Ronan, 15 Nov 2026)'),
  ('HERTS-001', 'Held on purpose (Ronan, 15 Nov 2026)'), ('WSP-173', 'Held on purpose (Ronan, 15 Nov 2026)');
