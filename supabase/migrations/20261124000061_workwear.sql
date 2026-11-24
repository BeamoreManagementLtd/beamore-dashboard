-- Workwear ordering on the clerk portal (Ronan, 24 Nov 2026), replacing the Apps Script form and the "Beamore
-- Workwear Orders" sheet: the catalogue, each person's orders (including those from the old form), and who may order.
create table if not exists workwear_items (
  id text primary key,
  type text not null,               -- polo | shirt | vest | jumper | outerwear | hivis
  name text not null,
  supplier_code text,
  image_url text,
  active boolean not null default true,
  sort int not null default 0
);
create table if not exists workwear_variants (
  item_id text not null references workwear_items(id) on delete cascade,
  colour text not null,
  size text not null,
  supplier_code text,
  image_url text,
  active boolean not null default true,
  sort int not null default 0,
  primary key (item_id, colour, size)
);
create table if not exists workwear_orders (
  id uuid primary key default gen_random_uuid(),
  clerk_id uuid references clerks(id) on delete set null,
  name text not null,
  contact text,
  address text,
  days_per_week int,
  notes text,
  status text not null default 'requested' check (status in ('requested', 'ordered', 'delivered', 'cancelled')),
  source text not null default 'portal',
  ref text unique,
  created_at timestamptz not null default now(),
  ordered_at timestamptz,
  delivered_at timestamptz
);
create table if not exists workwear_order_lines (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references workwear_orders(id) on delete cascade,
  item_id text,
  item_name text not null,
  supplier_code text,
  colour text,
  size text,
  quantity int not null default 1,
  link text,
  notes text
);
create index if not exists workwear_orders_clerk on workwear_orders (clerk_id, created_at desc);
alter table clerks add column if not exists workwear_allowed boolean not null default false;
alter table workwear_items enable row level security;
alter table workwear_variants enable row level security;
alter table workwear_orders enable row level security;
alter table workwear_order_lines enable row level security;
