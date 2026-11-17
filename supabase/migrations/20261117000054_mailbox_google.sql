-- A shared Beamore mailbox the dashboard sends from (Ronan, 17 Nov 2026: AI feedback emails come from ai@beamore.co.uk,
-- its own account). Send-only permission; read and written by the server only (no policies: service role).
create table if not exists mailbox_google (
  email text primary key,
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  connected_at timestamptz not null default now(),
  connected_by uuid references profiles(id)
);
alter table mailbox_google enable row level security;
