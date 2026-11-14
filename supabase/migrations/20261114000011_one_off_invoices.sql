-- One-off work that isn't a project (e.g. a site measure); kept out of 'not linked' on Fees by project.
alter table invoices add column one_off boolean not null default false;
alter table unmatched_diary_sites add column ignored boolean not null default false;
-- project_fees view recreated with one_off (see the live definition in Supabase).
