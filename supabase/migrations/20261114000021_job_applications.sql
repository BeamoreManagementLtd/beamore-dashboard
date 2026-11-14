-- People applying to work for Beamore (Indeed adverts, direct emails), picked up from Gmail for Find a clerk.
create table job_applications (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,
  thread_id text not null,
  name text not null,
  reply_to text,                 -- Indeed's relay address or their own email
  role text,                     -- "Clerk of Works"
  location text,                 -- "Hockley SS5 4UR"
  source text,                   -- Indeed / email
  received_at timestamptz,
  project_id uuid references projects (id),  -- the job it's for, when the advert names one
  status text not null default 'new' check (status in ('new', 'added', 'dismissed')),
  created_at timestamptz not null default now()
);
alter table job_applications enable row level security;
create policy staff_all on job_applications for all using (public.is_staff()) with check (public.is_staff());
alter table clerk_candidates drop constraint clerk_candidates_status_check;
alter table clerk_candidates add constraint clerk_candidates_status_check check (status in ('applied', 'approached', 'interested', 'interviewed', 'references', 'declined', 'appointed'));
alter table clerk_candidates add column application_id uuid references job_applications (id);
