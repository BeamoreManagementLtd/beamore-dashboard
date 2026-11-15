-- New clerk onboarding (Ronan, 15 Nov 2026): their personal address (for the welcome email) as well as the new
-- @beamore.co.uk one, and where the Beamore manual is (Andy Kay is writing it) so every new clerk is given it.
alter table clerks add column personal_email text;
create table onboarding_settings (
  id int primary key default 1 check (id = 1),
  manual_file_id text,
  manual_name text,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into onboarding_settings (id) values (1);
alter table onboarding_settings enable row level security;
create policy staff_read on onboarding_settings for select using (public.is_staff());
create policy director_write on onboarding_settings for update using (public.is_director()) with check (public.is_director());

-- Their details, filled in on the portal the first time they sign in (Ronan, 15 Nov 2026)
alter table clerk_compliance add column next_of_kin_name text;
alter table clerk_compliance add column next_of_kin_relationship text;
alter table clerk_compliance add column next_of_kin_phone text;
alter table clerk_compliance add column details_completed_at timestamptz;
-- clerks who already filled in the questionnaire aren't asked again
update clerk_compliance set details_completed_at = join_submitted_at where join_submitted_at is not null and details_completed_at is null;
