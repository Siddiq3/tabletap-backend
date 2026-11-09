-- 0002_supabase_security.sql
-- SUPABASE ONLY. Uses auth.uid() and the supabase_realtime publication.
-- On AWS (or any other backend) skip this file: the API layer enforces the same rules,
-- because every repository method already filters by restaurant_id.

create or replace function is_member(p_restaurant_id uuid, p_roles text[] default null)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from restaurant_members m
    where m.restaurant_id = p_restaurant_id
      and m.user_id = auth.uid()
      and (p_roles is null or m.role = any (p_roles))
  );
$$;

alter table restaurants        enable row level security;
alter table restaurant_members enable row level security;
alter table dining_tables      enable row level security;
alter table menu_categories    enable row level security;
alter table menu_items         enable row level security;
alter table orders             enable row level security;
alter table order_items        enable row level security;

-- restaurants
create policy restaurants_member_read on restaurants
  for select using (is_member(id));
create policy restaurants_owner_update on restaurants
  for update using (is_member(id, array['owner','manager']))
  with check (is_member(id, array['owner','manager']));

-- members
create policy members_read on restaurant_members
  for select using (user_id = auth.uid() or is_member(restaurant_id, array['owner']));

-- tables
create policy tables_member_read on dining_tables
  for select using (is_member(restaurant_id));
create policy tables_manager_write on dining_tables
  for all using (is_member(restaurant_id, array['owner','manager']))
  with check (is_member(restaurant_id, array['owner','manager']));

-- menu
create policy categories_member_read on menu_categories
  for select using (is_member(restaurant_id));
create policy categories_manager_write on menu_categories
  for all using (is_member(restaurant_id, array['owner','manager']))
  with check (is_member(restaurant_id, array['owner','manager']));

create policy items_member_read on menu_items
  for select using (is_member(restaurant_id));
create policy items_manager_write on menu_items
  for all using (is_member(restaurant_id, array['owner','manager']))
  with check (is_member(restaurant_id, array['owner','manager']));

-- orders: any staff member can read and move orders; nobody inserts directly
create policy orders_member_read on orders
  for select using (is_member(restaurant_id));
create policy orders_member_update on orders
  for update using (is_member(restaurant_id))
  with check (is_member(restaurant_id));

create policy order_items_member_read on order_items
  for select using (is_member(restaurant_id));

-- customer-facing reads and order placement go through the server (service role),
-- so the money-handling functions are not callable from browsers
revoke execute on function place_order(uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function create_restaurant(uuid, text, text, text, integer) from public, anon, authenticated;

-- live kitchen board
alter publication supabase_realtime add table orders;
