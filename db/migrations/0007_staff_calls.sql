-- Portable PostgreSQL. One outstanding call per restaurant/table, coalesced atomically.
create table staff_calls (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  table_id uuid not null references dining_tables(id) on delete cascade,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by_staff_id uuid references staff_members(id) on delete set null
);
create unique index staff_calls_one_pending on staff_calls(restaurant_id, table_id) where resolved_at is null;
create index staff_calls_pending on staff_calls(restaurant_id, created_at) where resolved_at is null;

create or replace function request_staff_call(p_restaurant_id uuid, p_table_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  -- Lock the table, so even concurrent guest requests become one pending call.
  perform 1 from dining_tables where id = p_table_id and restaurant_id = p_restaurant_id and is_active for update;
  if not found then raise exception 'INVALID_TABLE'; end if;
  perform 1 from restaurants where id = p_restaurant_id and plan <> 'suspended';
  if not found then raise exception 'RESTAURANT_UNAVAILABLE'; end if;
  select id into v_id from staff_calls where restaurant_id = p_restaurant_id and table_id = p_table_id and resolved_at is null;
  if v_id is not null then return v_id; end if;
  if exists (select 1 from staff_calls where restaurant_id = p_restaurant_id and table_id = p_table_id and created_at > now() - interval '30 seconds') then
    raise exception 'STAFF_CALL_COOLDOWN';
  end if;
  insert into staff_calls(restaurant_id, table_id) values(p_restaurant_id, p_table_id) returning id into v_id;
  return v_id;
end;
$$;
