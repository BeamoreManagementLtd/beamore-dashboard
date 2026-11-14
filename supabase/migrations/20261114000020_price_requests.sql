-- P1: emails that look like a request to price. The dashboard asks before creating a project.
create table price_requests (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,
  thread_id text not null,
  from_name text,
  from_email text,
  subject text,
  snippet text,
  received_at timestamptz,
  client_id uuid references clients (id),
  status text not null default 'new' check (status in ('new', 'created', 'ignored')),
  project_id uuid references projects (id),
  created_at timestamptz not null default now()
);
alter table price_requests enable row level security;
create policy staff_all on price_requests for all using (public.is_staff()) with check (public.is_staff());

-- attachments already saved into a project's Drive folder (S5), so each is saved once
create table saved_attachments (
  message_id text not null,
  attachment_name text not null,
  project_id uuid not null references projects (id) on delete cascade,
  drive_file_id text,
  saved_at timestamptz not null default now(),
  primary key (message_id, attachment_name)
);
alter table saved_attachments enable row level security;
create policy staff_all on saved_attachments for all using (public.is_staff()) with check (public.is_staff());
