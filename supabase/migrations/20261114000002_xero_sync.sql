-- Xero connection (one row) and Xero references that match no project.

-- Tokens are readable only by the server's service role: RLS on, no policies.
create table xero_connection (
  id int primary key default 1 check (id = 1),
  tenant_id text not null,
  tenant_name text,
  refresh_token text not null,
  access_token text,
  access_expires_at timestamptz,
  connected_by uuid references profiles (id),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table xero_connection enable row level security;

-- What the director's Finance page may know about the connection (never the tokens).
create function public.xero_connection_status()
returns table (tenant_name text, connected_at timestamptz)
language sql stable security definer set search_path = public as $$
  select tenant_name, connected_at from xero_connection where public.is_director();
$$;

-- Invoice references from Xero that don't match any project's name or diary spelling.
create table unmatched_invoice_refs (
  reference_key text primary key,
  reference text not null,
  last_invoice text,
  client text,
  invoices int not null default 1,
  first_seen date not null default current_date,
  last_seen date not null default current_date
);
alter table unmatched_invoice_refs enable row level security;
create policy staff_all on unmatched_invoice_refs for all using (public.is_staff()) with check (public.is_staff());
