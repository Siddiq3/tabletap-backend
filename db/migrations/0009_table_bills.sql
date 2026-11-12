-- 0009_table_bills.sql
-- Portable PostgreSQL. One running bill per table.
-- A table's open bill = its non-cancelled orders with settled_at null, however they were placed:
-- the guest's QR (once or many times) or staff adding items for the guest.
-- Settling marks the unpaid ones paid and closes the bill, so the next guests start a fresh one.

alter table orders add column settled_at timestamptz;

-- Orders from before this migration are history, not open bills.
update orders set settled_at = updated_at where created_at < now() - interval '1 day';

create index orders_open_bills_idx on orders(restaurant_id, table_id) where settled_at is null;

-- p_order_ids is exactly the set of orders on the bill the cashier printed. If a guest added
-- something since, the sets differ and we refuse (BILL_CHANGED) instead of marking an
-- order paid that was never on the printed bill.
create or replace function settle_table_bill(
  p_restaurant_id uuid,
  p_table_id      uuid,
  p_order_ids     uuid[],
  p_method        text,
  p_staff_id      uuid
) returns integer
language plpgsql as $$
declare
  v_open  uuid[];
  v_given uuid[];
begin
  if p_method is null or p_method not in ('upi', 'cash', 'card', 'online') then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;

  -- Two cashiers settling the same table: the second waits here, then finds nothing open.
  perform 1 from dining_tables where id = p_table_id and restaurant_id = p_restaurant_id for update;
  if not found then raise exception 'INVALID_TABLE'; end if;

  perform 1 from orders
   where restaurant_id = p_restaurant_id and table_id = p_table_id and settled_at is null and status <> 'cancelled'
   for update;

  select coalesce(array_agg(id order by id), '{}') into v_open
    from orders
   where restaurant_id = p_restaurant_id and table_id = p_table_id and settled_at is null and status <> 'cancelled';

  if cardinality(v_open) = 0 then raise exception 'BILL_EMPTY'; end if;

  select coalesce(array_agg(distinct x order by x), '{}') into v_given from unnest(p_order_ids) x;
  if v_open is distinct from v_given then raise exception 'BILL_CHANGED'; end if;

  update orders
     set payment_status = 'paid', payment_method = p_method, paid_by_staff_id = p_staff_id
   where id = any(v_open) and payment_status = 'unpaid';

  -- Close only what was on the bill (plus cancelled leftovers). A guest order that commits while
  -- we run is not in v_open, so it stays open and starts the next bill instead of vanishing.
  update orders
     set settled_at = now()
   where id = any(v_open)
      or (restaurant_id = p_restaurant_id and table_id = p_table_id and settled_at is null and status = 'cancelled');

  return cardinality(v_open);
end $$;
