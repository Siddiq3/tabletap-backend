-- 0001_core_schema.sql
-- Portable PostgreSQL. Runs unchanged on Supabase, AWS RDS/Aurora, Neon or any Postgres 14+.
-- Rules that keep it portable:
--   * no references to auth.* tables (user ids are plain uuids from whichever login provider we use)
--   * all money stored as integer paise
--   * business-critical writes (placing an order, creating a restaurant) live in plpgsql functions,
--     so every backend (Supabase RPC, a Node API on AWS, a Lambda) calls the same logic.

create extension if not exists pgcrypto;

-- ---------- tenants ----------
create table restaurants (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name          text not null check (char_length(name) between 2 and 80),
  address       text,
  phone         text,
  upi_id        text,
  tax_percent   numeric(5,2) not null default 5 check (tax_percent >= 0 and tax_percent <= 28),
  plan          text not null default 'trial' check (plan in ('trial','basic','pro','multi','suspended')),
  trial_ends_at timestamptz not null default now() + interval '14 days',
  order_seq     integer not null default 1000,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table restaurant_members (
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  user_id       uuid not null,  -- id from the login provider; deliberately no foreign key
  role          text not null check (role in ('owner','manager','cashier','kitchen','waiter')),
  created_at    timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);
create index restaurant_members_user_idx on restaurant_members(user_id);

create table dining_tables (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  label         text not null,
  seats         smallint not null default 4 check (seats between 1 and 50),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (restaurant_id, label)
);

-- ---------- menu ----------
create table menu_categories (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  name          text not null,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now()
);
create index menu_categories_restaurant_idx on menu_categories(restaurant_id, sort_order);

create table menu_items (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  category_id   uuid references menu_categories(id) on delete set null,
  name          text not null check (char_length(name) between 1 and 80),
  description   text,
  price_paise   integer not null check (price_paise >= 0),
  is_veg        boolean not null default true,
  is_available  boolean not null default true,
  image_url     text,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index menu_items_restaurant_idx on menu_items(restaurant_id, category_id, sort_order);

-- ---------- orders ----------
create table orders (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  uuid not null references restaurants(id) on delete cascade,
  table_id       uuid references dining_tables(id) on delete set null,
  order_no       integer not null,
  status         text not null default 'new' check (status in ('new','preparing','ready','served','cancelled')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','refunded')),
  payment_method text check (payment_method in ('upi','cash','card','online')),
  note           text check (char_length(note) <= 300),
  subtotal_paise integer not null,
  tax_paise      integer not null,
  total_paise    integer not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (restaurant_id, order_no)
);
create index orders_board_idx on orders(restaurant_id, status, created_at desc);

-- line items keep a snapshot of name and price, so editing the menu never changes old bills
create table order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references orders(id) on delete cascade,
  restaurant_id    uuid not null references restaurants(id) on delete cascade,
  menu_item_id     uuid references menu_items(id) on delete set null,
  name             text not null,
  is_veg           boolean not null,
  unit_price_paise integer not null,
  qty              smallint not null check (qty between 1 and 50)
);
create index order_items_order_idx on order_items(order_id);

-- ---------- updated_at ----------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger restaurants_updated_at before update on restaurants for each row execute function set_updated_at();
create trigger menu_items_updated_at  before update on menu_items  for each row execute function set_updated_at();
create trigger orders_updated_at      before update on orders      for each row execute function set_updated_at();

-- ---------- create_restaurant: one transaction for restaurant + owner + tables ----------
create or replace function create_restaurant(
  p_owner_id    uuid,
  p_name        text,
  p_slug        text,
  p_upi_id      text,
  p_table_count integer
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  if p_table_count < 1 or p_table_count > 200 then
    raise exception 'INVALID_TABLE_COUNT';
  end if;

  insert into restaurants (name, slug, upi_id)
  values (trim(p_name), lower(trim(p_slug)), nullif(trim(p_upi_id), ''))
  returning id into v_id;

  insert into restaurant_members (restaurant_id, user_id, role)
  values (v_id, p_owner_id, 'owner');

  insert into dining_tables (restaurant_id, label)
  select v_id, 'T' || g from generate_series(1, p_table_count) g;

  return v_id;
end $$;

-- ---------- place_order: prices always come from the database, never from the phone ----------
create or replace function place_order(
  p_restaurant_id uuid,
  p_table_id      uuid,
  p_items         jsonb,   -- [{"menu_item_id": "...", "qty": 2}, ...]
  p_note          text
) returns table (out_order_id uuid, out_order_no integer, out_total_paise integer)
language plpgsql as $$
declare
  v_no    integer;
  v_tax   numeric;
  v_sub   integer;
  v_lines integer;
  v_taxp  integer;
  v_id    uuid;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ORDER';
  end if;

  if not exists (
    select 1 from dining_tables t
    where t.id = p_table_id and t.restaurant_id = p_restaurant_id and t.is_active
  ) then
    raise exception 'INVALID_TABLE';
  end if;

  select count(*), coalesce(sum(m.price_paise * (x->>'qty')::int), 0)
    into v_lines, v_sub
  from jsonb_array_elements(p_items) x
  join menu_items m on m.id = (x->>'menu_item_id')::uuid
  where m.restaurant_id = p_restaurant_id
    and m.is_available
    and (x->>'qty')::int between 1 and 50;

  if v_lines <> jsonb_array_length(p_items) then
    raise exception 'ITEM_UNAVAILABLE';
  end if;

  -- row lock on the restaurant gives each restaurant its own gap-free order numbers
  update restaurants
     set order_seq = order_seq + 1
   where id = p_restaurant_id and plan <> 'suspended'
  returning order_seq, tax_percent into v_no, v_tax;

  if v_no is null then
    raise exception 'RESTAURANT_UNAVAILABLE';
  end if;

  v_taxp := round(v_sub * v_tax / 100);

  insert into orders (restaurant_id, table_id, order_no, note, subtotal_paise, tax_paise, total_paise)
  values (p_restaurant_id, p_table_id, v_no, nullif(trim(p_note), ''), v_sub, v_taxp, v_sub + v_taxp)
  returning id into v_id;

  insert into order_items (order_id, restaurant_id, menu_item_id, name, is_veg, unit_price_paise, qty)
  select v_id, p_restaurant_id, m.id, m.name, m.is_veg, m.price_paise, (x->>'qty')::int
  from jsonb_array_elements(p_items) x
  join menu_items m on m.id = (x->>'menu_item_id')::uuid
  where m.restaurant_id = p_restaurant_id;

  return query select v_id, v_no, v_sub + v_taxp;
end $$;
