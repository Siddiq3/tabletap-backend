-- 0011_restaurant_pos.sql
-- Portable PostgreSQL. Everything a restaurant needs at the counter, so no second billing software:
--   * bills: one per table visit (or per takeaway), with a GST invoice number from the start
--   * all rounds join the bill: guest QR orders and items staff add (orders.source / placed_by)
--   * discount, service charge (dine-in), packaging charge (takeaway), GST, round-off to the rupee
--   * split payments (any mix of cash/UPI/card); the bill closes when fully paid
--   * move a bill to another table, merge two bills, void a bill
--   * cancel an item with a reason (kept for reports)
--   * sales report / day close
-- All money maths lives here (bill_amounts) so web, app and reports always agree.

-- ---------- restaurant settings ----------
alter table restaurants
  add column gstin                  text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  add column fssai                  text check (fssai is null or fssai ~ '^[0-9]{14}$'),
  add column service_charge_percent numeric(5,2) not null default 0 check (service_charge_percent between 0 and 20),
  add column packaging_paise        integer not null default 0 check (packaging_paise between 0 and 100000),
  add column invoice_seq            integer not null default 0;

-- ---------- bills ----------
create table bills (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references restaurants(id) on delete cascade,
  invoice_no          integer not null,
  kind                text not null default 'dine_in' check (kind in ('dine_in', 'takeaway')),
  table_id            uuid references dining_tables(id) on delete set null,
  status              text not null default 'open' check (status in ('open', 'settled', 'void')),
  customer_name       text check (char_length(customer_name) <= 60),
  customer_phone      text check (char_length(customer_phone) <= 15),
  discount_paise      integer not null default 0 check (discount_paise >= 0),
  discount_reason     text check (char_length(discount_reason) <= 120),
  service_charge_on   boolean not null default true,
  -- frozen when the bill closes, so later setting changes never alter an issued invoice
  subtotal_paise       integer,
  service_charge_paise integer,
  packaging_paise      integer,
  tax_paise            integer,
  round_off_paise      integer,
  total_paise          integer,
  opened_at           timestamptz not null default now(),
  settled_at          timestamptz,
  settled_by_staff_id uuid references staff_members(id) on delete set null,
  void_reason         text check (char_length(void_reason) <= 120),
  unique (restaurant_id, invoice_no)
);
create unique index bills_one_open_per_table on bills(restaurant_id, table_id) where status = 'open' and table_id is not null;
create index bills_open_idx on bills(restaurant_id) where status = 'open';
create index bills_settled_idx on bills(restaurant_id, settled_at) where status = 'settled';

alter table orders
  add column bill_id            uuid references bills(id) on delete set null,
  add column source             text not null default 'qr' check (source in ('qr', 'staff')),
  add column placed_by_staff_id uuid references staff_members(id) on delete set null;
create index orders_bill_idx on orders(bill_id);

create table bill_payments (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants(id) on delete cascade,
  bill_id       uuid not null references bills(id) on delete cascade,
  method        text not null check (method in ('upi', 'cash', 'card', 'online')),
  amount_paise  integer not null check (amount_paise > 0),
  staff_id      uuid references staff_members(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index bill_payments_bill_idx on bill_payments(bill_id);
create index bill_payments_day_idx on bill_payments(restaurant_id, created_at);

create table item_cancellations (
  id               uuid primary key default gen_random_uuid(),
  restaurant_id    uuid not null references restaurants(id) on delete cascade,
  order_id         uuid not null references orders(id) on delete cascade,
  name             text not null,
  unit_price_paise integer not null,
  qty              smallint not null check (qty between 1 and 50),
  reason           text not null check (char_length(reason) between 2 and 120),
  staff_id         uuid references staff_members(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index item_cancellations_day_idx on item_cancellations(restaurant_id, created_at);

-- ---------- money: the one place totals are computed ----------
-- taxable = subtotal − discount + service charge (dine-in) + packaging (takeaway); GST on taxable;
-- total rounded to the nearest rupee. Settled bills keep their frozen columns (see close_bill).
create or replace view bill_amounts as
select b.id as bill_id, b.restaurant_id,
       o.s as subtotal, d.discount, c.service, c.packaging, g.tax,
       z.total - w.raw as round_off, z.total, coalesce(p.paid, 0)::int as paid
  from bills b
  join restaurants r on r.id = b.restaurant_id
  cross join lateral (select coalesce(sum(subtotal_paise), 0)::int as s from orders x where x.bill_id = b.id and x.status <> 'cancelled') o
  cross join lateral (select coalesce(sum(amount_paise), 0)::int as paid from bill_payments y where y.bill_id = b.id) p
  cross join lateral (select least(b.discount_paise, o.s) as discount) d
  cross join lateral (select
      case when b.kind = 'dine_in' and b.service_charge_on then round((o.s - d.discount) * r.service_charge_percent / 100)::int else 0 end as service,
      case when b.kind = 'takeaway' and o.s > 0 then r.packaging_paise else 0 end as packaging) c
  cross join lateral (select round((o.s - d.discount + c.service + c.packaging) * r.tax_percent / 100)::int as tax) g
  cross join lateral (select o.s - d.discount + c.service + c.packaging + g.tax as raw) w
  cross join lateral (select (round(w.raw / 100.0) * 100)::int as total) z;

-- ---------- invoice numbers ----------
create or replace function next_invoice_no(p_restaurant_id uuid) returns integer
language sql as $$
  update restaurants set invoice_seq = invoice_seq + 1
   where id = p_restaurant_id and plan <> 'suspended'
  returning invoice_seq
$$;

-- The table's open bill, created on the first order. The table row lock serializes concurrent guests;
-- the bill row lock makes a payment in progress wait for (or be waited on by) a new order.
create or replace function open_table_bill(p_restaurant_id uuid, p_table_id uuid) returns uuid
language plpgsql as $$
declare v_id uuid; v_no integer;
begin
  perform 1 from dining_tables where id = p_table_id and restaurant_id = p_restaurant_id and is_active for update;
  if not found then raise exception 'INVALID_TABLE'; end if;
  select id into v_id from bills
   where restaurant_id = p_restaurant_id and table_id = p_table_id and status = 'open' for update;
  if v_id is not null then return v_id; end if;
  v_no := next_invoice_no(p_restaurant_id);
  if v_no is null then raise exception 'RESTAURANT_UNAVAILABLE'; end if;
  insert into bills (restaurant_id, invoice_no, kind, table_id) values (p_restaurant_id, v_no, 'dine_in', p_table_id)
  returning id into v_id;
  return v_id;
end $$;

-- ---------- orders join bills ----------
-- One entry point for every order: guest QR (place_order), staff adding to a table or a bill, new takeaway.
-- Prices always come from the menu, never from the caller.
create or replace function add_order(
  p_restaurant_id  uuid,
  p_table_id       uuid,
  p_bill_id        uuid,
  p_items          jsonb,
  p_note           text,
  p_source         text,
  p_staff_id       uuid,
  p_takeaway       boolean default false,
  p_customer_name  text default null,
  p_customer_phone text default null
) returns table (out_order_id uuid, out_order_no integer, out_total_paise integer, out_bill_id uuid)
language plpgsql as $$
declare
  v_no integer; v_tax numeric; v_sub integer; v_lines integer; v_taxp integer;
  v_id uuid; v_bill uuid; v_table uuid; v_inv integer;
begin
  if p_source is null or p_source not in ('qr', 'staff') then raise exception 'INVALID_SOURCE'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_ORDER'; end if;

  select count(*), coalesce(sum(m.price_paise * (x->>'qty')::int), 0) into v_lines, v_sub
    from jsonb_array_elements(p_items) x
    join menu_items m on m.id = (x->>'menu_item_id')::uuid
   where m.restaurant_id = p_restaurant_id and m.is_available and (x->>'qty')::int between 1 and 50;
  if v_lines <> jsonb_array_length(p_items) then raise exception 'ITEM_UNAVAILABLE'; end if;

  if p_takeaway then
    v_inv := next_invoice_no(p_restaurant_id);
    if v_inv is null then raise exception 'RESTAURANT_UNAVAILABLE'; end if;
    insert into bills (restaurant_id, invoice_no, kind, customer_name, customer_phone)
    values (p_restaurant_id, v_inv, 'takeaway', nullif(trim(p_customer_name), ''), nullif(trim(p_customer_phone), ''))
    returning id into v_bill;
  elsif p_bill_id is not null then
    select id, table_id into v_bill, v_table from bills
     where id = p_bill_id and restaurant_id = p_restaurant_id and status = 'open' for update;
    if v_bill is null then raise exception 'BILL_CLOSED'; end if;
  else
    v_bill := open_table_bill(p_restaurant_id, p_table_id);
    v_table := p_table_id;
  end if;

  update restaurants set order_seq = order_seq + 1
   where id = p_restaurant_id and plan <> 'suspended'
  returning order_seq, tax_percent into v_no, v_tax;
  if v_no is null then raise exception 'RESTAURANT_UNAVAILABLE'; end if;

  v_taxp := round(v_sub * v_tax / 100);
  insert into orders (restaurant_id, table_id, bill_id, order_no, note, subtotal_paise, tax_paise, total_paise, source, placed_by_staff_id)
  values (p_restaurant_id, v_table, v_bill, v_no, nullif(trim(p_note), ''), v_sub, v_taxp, v_sub + v_taxp, p_source, p_staff_id)
  returning id into v_id;

  insert into order_items (order_id, restaurant_id, menu_item_id, name, is_veg, unit_price_paise, qty)
  select v_id, p_restaurant_id, m.id, m.name, m.is_veg, m.price_paise, (x->>'qty')::int
    from jsonb_array_elements(p_items) x
    join menu_items m on m.id = (x->>'menu_item_id')::uuid
   where m.restaurant_id = p_restaurant_id;

  return query select v_id, v_no, v_sub + v_taxp, v_bill;
end $$;

-- Guests keep the same entry point and signature; their order now joins the table's bill.
create or replace function place_order(
  p_restaurant_id uuid,
  p_table_id      uuid,
  p_items         jsonb,
  p_note          text
) returns table (out_order_id uuid, out_order_no integer, out_total_paise integer)
language plpgsql as $$
begin
  return query select a.out_order_id, a.out_order_no, a.out_total_paise
    from add_order(p_restaurant_id, p_table_id, null, p_items, p_note, 'qr', null) a;
end $$;

-- ---------- payments ----------
-- Internal: freeze the amounts, mark the rounds paid, close the bill.
create or replace function close_bill(p_bill_id uuid, p_method text, p_staff_id uuid) returns void
language plpgsql as $$
begin
  update bills b
     set status = 'settled', settled_at = now(), settled_by_staff_id = p_staff_id,
         subtotal_paise = a.subtotal, discount_paise = a.discount, service_charge_paise = a.service,
         packaging_paise = a.packaging, tax_paise = a.tax, round_off_paise = a.round_off, total_paise = a.total
    from bill_amounts a
   where a.bill_id = b.id and b.id = p_bill_id;
  update orders
     set payment_status = 'paid', payment_method = p_method, paid_by_staff_id = p_staff_id
   where bill_id = p_bill_id and status <> 'cancelled' and payment_status = 'unpaid';
  update orders set settled_at = now() where bill_id = p_bill_id and settled_at is null;
end $$;

-- p_expected_total is the total the cashier saw. If a round was added (or anything changed) since,
-- refuse with BILL_CHANGED instead of taking money against a bill nobody checked.
-- Split payments: call once per payment; the bill closes when the total is covered.
create or replace function add_bill_payment(
  p_restaurant_id  uuid,
  p_bill_id        uuid,
  p_method         text,
  p_amount_paise   integer,
  p_expected_total integer,
  p_staff_id       uuid
) returns text
language plpgsql as $$
declare v_total integer; v_paid integer;
begin
  if p_method is null or p_method not in ('upi', 'cash', 'card', 'online') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  perform 1 from bills where id = p_bill_id and restaurant_id = p_restaurant_id and status = 'open' for update;
  if not found then raise exception 'BILL_CLOSED'; end if;
  select total, paid into v_total, v_paid from bill_amounts where bill_id = p_bill_id;
  if v_total is distinct from p_expected_total then raise exception 'BILL_CHANGED'; end if;
  if v_total <= 0 then raise exception 'BILL_EMPTY'; end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > v_total - v_paid then
    raise exception 'INVALID_PAYMENT_AMOUNT';
  end if;
  insert into bill_payments (restaurant_id, bill_id, method, amount_paise, staff_id)
  values (p_restaurant_id, p_bill_id, p_method, p_amount_paise, p_staff_id);
  if v_paid + p_amount_paise >= v_total then
    perform close_bill(p_bill_id, p_method, p_staff_id);
    return 'settled';
  end if;
  return 'open';
end $$;

-- "Paid" on a single round (board buttons, guest paid one round by UPI): a payment for that round's
-- total against its bill; if that covers the whole bill, the bill closes.
create or replace function mark_order_paid(p_restaurant_id uuid, p_order_id uuid, p_method text, p_staff_id uuid) returns void
language plpgsql as $$
declare v_bill uuid; v_order_total integer; v_total integer; v_paid integer; v_amount integer;
begin
  if p_method is null or p_method not in ('upi', 'cash', 'card', 'online') then raise exception 'INVALID_PAYMENT_METHOD'; end if;
  select bill_id, total_paise into v_bill, v_order_total from orders
   where id = p_order_id and restaurant_id = p_restaurant_id and payment_status = 'unpaid' for update;
  if not found then return; end if; -- already paid: nothing to do
  if v_bill is not null then
    perform 1 from bills where id = v_bill and status = 'open' for update;
    if found then
      select total, paid into v_total, v_paid from bill_amounts where bill_id = v_bill;
      -- The last unpaid round settles whatever is left (service charge, packaging, round-off),
      -- otherwise "paid" on every round would still leave a few rupees open on the bill.
      if exists (select 1 from orders where bill_id = v_bill and id <> p_order_id and status <> 'cancelled' and payment_status = 'unpaid') then
        v_amount := least(v_order_total, v_total - v_paid);
      else
        v_amount := v_total - v_paid;
      end if;
      if v_amount > 0 then
        insert into bill_payments (restaurant_id, bill_id, method, amount_paise, staff_id)
        values (p_restaurant_id, v_bill, p_method, v_amount, p_staff_id);
      end if;
      update orders set payment_status = 'paid', payment_method = p_method, paid_by_staff_id = p_staff_id where id = p_order_id;
      if v_paid + greatest(v_amount, 0) >= v_total then perform close_bill(v_bill, p_method, p_staff_id); end if;
      return;
    end if;
  end if;
  update orders set payment_status = 'paid', payment_method = p_method, paid_by_staff_id = p_staff_id where id = p_order_id;
end $$;

-- ---------- tables ----------
create or replace function move_bill(p_restaurant_id uuid, p_bill_id uuid, p_to_table_id uuid) returns void
language plpgsql as $$
begin
  perform 1 from dining_tables where id = p_to_table_id and restaurant_id = p_restaurant_id and is_active for update;
  if not found then raise exception 'INVALID_TABLE'; end if;
  perform 1 from bills where id = p_bill_id and restaurant_id = p_restaurant_id and status = 'open' and kind = 'dine_in' for update;
  if not found then raise exception 'BILL_CLOSED'; end if;
  if exists (select 1 from bills where restaurant_id = p_restaurant_id and table_id = p_to_table_id and status = 'open' and id <> p_bill_id) then
    raise exception 'TABLE_BUSY';
  end if;
  update bills set table_id = p_to_table_id where id = p_bill_id;
  update orders set table_id = p_to_table_id where bill_id = p_bill_id;
end $$;

-- Everything on p_from (rounds and payments) moves onto p_into; p_from is voided with a note.
create or replace function merge_bills(p_restaurant_id uuid, p_from uuid, p_into uuid, p_staff_id uuid) returns void
language plpgsql as $$
declare v_into_table uuid; v_into_no integer;
begin
  if p_from = p_into then raise exception 'BILL_CHANGED'; end if;
  perform 1 from bills where id in (p_from, p_into) and restaurant_id = p_restaurant_id and status = 'open' order by id for update;
  if (select count(*) from bills where id in (p_from, p_into) and restaurant_id = p_restaurant_id and status = 'open') <> 2 then
    raise exception 'BILL_CLOSED';
  end if;
  select table_id, invoice_no into v_into_table, v_into_no from bills where id = p_into;
  update orders set bill_id = p_into, table_id = coalesce(v_into_table, table_id) where bill_id = p_from;
  update bill_payments set bill_id = p_into where bill_id = p_from;
  update bills set status = 'void', void_reason = 'Merged into invoice ' || v_into_no, settled_at = now(), settled_by_staff_id = p_staff_id
   where id = p_from;
end $$;

-- Walk-outs and mistakes. Only bills with no payments; their rounds are cancelled.
create or replace function void_bill(p_restaurant_id uuid, p_bill_id uuid, p_reason text, p_staff_id uuid) returns void
language plpgsql as $$
begin
  if p_reason is null or char_length(trim(p_reason)) < 2 then raise exception 'REASON_REQUIRED'; end if;
  perform 1 from bills where id = p_bill_id and restaurant_id = p_restaurant_id and status = 'open' for update;
  if not found then raise exception 'BILL_CLOSED'; end if;
  if exists (select 1 from bill_payments where bill_id = p_bill_id) then raise exception 'BILL_HAS_PAYMENTS'; end if;
  update orders set status = 'cancelled', status_changed_by_staff_id = p_staff_id where bill_id = p_bill_id and status <> 'cancelled';
  update orders set settled_at = now() where bill_id = p_bill_id and settled_at is null;
  update bills set status = 'void', void_reason = trim(p_reason), settled_at = now(), settled_by_staff_id = p_staff_id where id = p_bill_id;
end $$;

-- ---------- cancel an item ----------
create or replace function cancel_order_item(
  p_restaurant_id uuid, p_order_item_id uuid, p_qty integer, p_reason text, p_staff_id uuid
) returns void
language plpgsql as $$
declare v_order uuid; v_qty integer; v_price integer; v_name text; v_bill uuid; v_sub integer; v_tax numeric;
begin
  if p_reason is null or char_length(trim(p_reason)) < 2 then raise exception 'REASON_REQUIRED'; end if;
  select order_id, qty, unit_price_paise, name into v_order, v_qty, v_price, v_name
    from order_items where id = p_order_item_id and restaurant_id = p_restaurant_id for update;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  select bill_id into v_bill from orders where id = v_order and status <> 'cancelled' for update;
  if not found then raise exception 'ITEM_NOT_FOUND'; end if;
  if v_bill is not null and not exists (select 1 from bills where id = v_bill and status = 'open') then raise exception 'BILL_CLOSED'; end if;
  if p_qty is null or p_qty < 1 or p_qty > v_qty then raise exception 'INVALID_QTY'; end if;

  insert into item_cancellations (restaurant_id, order_id, name, unit_price_paise, qty, reason, staff_id)
  values (p_restaurant_id, v_order, v_name, v_price, p_qty, trim(p_reason), p_staff_id);
  if p_qty = v_qty then delete from order_items where id = p_order_item_id;
  else update order_items set qty = qty - p_qty where id = p_order_item_id; end if;

  select coalesce(sum(unit_price_paise * qty), 0) into v_sub from order_items where order_id = v_order;
  select tax_percent into v_tax from restaurants where id = p_restaurant_id;
  if v_sub = 0 then
    update orders set status = 'cancelled', subtotal_paise = 0, tax_paise = 0, total_paise = 0, status_changed_by_staff_id = p_staff_id where id = v_order;
  else
    update orders set subtotal_paise = v_sub, tax_paise = round(v_sub * v_tax / 100), total_paise = v_sub + round(v_sub * v_tax / 100) where id = v_order;
  end if;
end $$;

-- ---------- reports ----------
-- Settled bills in [p_from, p_to): sales, GST, payment methods, top dishes, cancellations, voids.
create or replace function sales_report(p_restaurant_id uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable as $$
  with b as (
    select * from bills where restaurant_id = p_restaurant_id and status = 'settled' and settled_at >= p_from and settled_at < p_to
  ), pay as (
    select y.method, sum(y.amount_paise)::bigint as amount, count(*) as n
      from bill_payments y join b on b.id = y.bill_id group by y.method
  ), items as (
    select i.name, sum(i.qty)::bigint as qty, sum(i.qty * i.unit_price_paise)::bigint as amount
      from order_items i join orders o on o.id = i.order_id join b on b.id = o.bill_id
     where o.status <> 'cancelled' group by i.name order by qty desc, amount desc limit 10
  ), canc as (
    select count(*) as n, coalesce(sum(qty * unit_price_paise), 0)::bigint as amount
      from item_cancellations where restaurant_id = p_restaurant_id and created_at >= p_from and created_at < p_to
  )
  select jsonb_build_object(
    'bills', (select count(*) from b),
    'dineIn', (select count(*) from b where kind = 'dine_in'),
    'takeaway', (select count(*) from b where kind = 'takeaway'),
    'subtotalPaise', (select coalesce(sum(subtotal_paise), 0) from b),
    'discountPaise', (select coalesce(sum(discount_paise), 0) from b),
    'serviceChargePaise', (select coalesce(sum(service_charge_paise), 0) from b),
    'packagingPaise', (select coalesce(sum(packaging_paise), 0) from b),
    'taxPaise', (select coalesce(sum(tax_paise), 0) from b),
    'roundOffPaise', (select coalesce(sum(round_off_paise), 0) from b),
    'totalPaise', (select coalesce(sum(total_paise), 0) from b),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'amountPaise', amount, 'count', n) order by amount desc) from pay), '[]'::jsonb),
    'topItems', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'qty', qty, 'amountPaise', amount)) from items), '[]'::jsonb),
    'cancelledItems', (select n from canc),
    'cancelledPaise', (select amount from canc),
    'voidBills', (select count(*) from bills where restaurant_id = p_restaurant_id and status = 'void' and void_reason not like 'Merged into%' and settled_at >= p_from and settled_at < p_to),
    'firstInvoice', (select min(invoice_no) from b),
    'lastInvoice', (select max(invoice_no) from b)
  )
$$;

-- ---------- existing data ----------
-- Open orders from migration 0009 become open bills, with their already-paid rounds as payments.
do $$
declare r record; v_no integer; v_bill uuid;
begin
  for r in
    select distinct restaurant_id, table_id from orders
     where settled_at is null and table_id is not null and status <> 'cancelled' and bill_id is null
  loop
    update restaurants set invoice_seq = invoice_seq + 1 where id = r.restaurant_id returning invoice_seq into v_no;
    insert into bills (restaurant_id, invoice_no, kind, table_id) values (r.restaurant_id, v_no, 'dine_in', r.table_id)
    returning id into v_bill;
    update orders set bill_id = v_bill
     where restaurant_id = r.restaurant_id and table_id = r.table_id and settled_at is null and bill_id is null;
    insert into bill_payments (restaurant_id, bill_id, method, amount_paise, staff_id)
    select restaurant_id, v_bill, coalesce(payment_method, 'cash'), total_paise, paid_by_staff_id
      from orders where bill_id = v_bill and status <> 'cancelled' and payment_status = 'paid' and total_paise > 0;
  end loop;
end $$;

-- Superseded by bills + add_bill_payment.
drop function if exists settle_table_bill(uuid, uuid, uuid[], text, uuid);
