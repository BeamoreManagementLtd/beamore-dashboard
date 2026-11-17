-- A job that only needs an M&E clerk (Ronan, 17 Nov 2026: Airbus Bristol is M&E only, Andy Collier)
alter table projects drop constraint if exists projects_clerk_status_check;
alter table projects add constraint projects_clerk_status_check check (clerk_status in ('have', 'finding', 'none'));
