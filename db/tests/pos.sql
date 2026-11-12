-- Run on a disposable database after migrations 0001-0012. Everything rolls back.
-- Covers: bills + invoice numbers, guest/staff/takeaway orders, money maths, split payments,
-- stale totals, move/merge/void, item cancellation and the sales report.
begin;
insert into restaurants(id, slug, name, tax_percent, service_charge_percent, packaging_paise) values
 ('a1111111-1111-1111-1111-111111111111', 'pos-test-a', 'POS A', 5, 10, 2000),
 ('b1111111-1111-1111-1111-111111111111', 'pos-test-b', 'POS B', 5, 0, 0);
insert into dining_tables(id, restaurant_id, label) values
 ('a3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 'T7'),
 ('a3333333-3333-3333-3333-333333333334', 'a1111111-1111-1111-1111-111111111111', 'T8'),
 ('a3333333-3333-3333-3333-333333333335', 'a1111111-1111-1111-1111-111111111111', 'T9'),
 ('b3333333-3333-3333-3333-333333333333', 'b1111111-1111-1111-1111-111111111111', 'T1');
insert into menu_items(id, restaurant_id, name, price_paise) values
 ('a4444444-4444-4444-4444-444444444441', 'a1111111-1111-1111-1111-111111111111', 'Paneer tikka bowl', 24000),
 ('a4444444-4444-4444-4444-444444444442', 'a1111111-1111-1111-1111-111111111111', 'Garlic naan', 6000),
 ('a4444444-4444-4444-4444-444444444443', 'a1111111-1111-1111-1111-111111111111', 'Lemon iced tea', 9000);

do $$
declare
  rid constant uuid := 'a1111111-1111-1111-1111-111111111111';
  t7 constant uuid := 'a3333333-3333-3333-3333-333333333333';
  t8 constant uuid := 'a3333333-3333-3333-3333-333333333334';
  t9 constant uuid := 'a3333333-3333-3333-3333-333333333335';
  paneer constant text := 'a4444444-4444-4444-4444-444444444441';
  naan constant text := 'a4444444-4444-4444-4444-444444444442';
  tea constant text := 'a4444444-4444-4444-4444-444444444443';
  bill uuid; bill2 uuid; tk uuid; o uuid; a record; st text; item uuid; rep jsonb;
begin
  -- Guest orders by QR, then the waiter adds naan: same bill, invoice 1, rounds marked by source.
  perform place_order(rid, t7, format('[{"menu_item_id":"%s","qty":2}]', paneer)::jsonb, 'Less spicy');
  select out_bill_id into bill from add_order(rid, t7, null, format('[{"menu_item_id":"%s","qty":1}]', naan)::jsonb, '', 'staff', null);
  if (select count(*) from orders where bill_id = bill) <> 2 then raise exception 'Rounds did not join one bill'; end if;
  if (select invoice_no from bills where id = bill) <> 1 then raise exception 'First invoice is not 1'; end if;
  if (select array_agg(source order by order_no) from orders where bill_id = bill) <> array['qr', 'staff'] then raise exception 'Order source not recorded'; end if;

  -- Money: 540 − 40 discount = 500; +10% service 50 = 550; +5% GST 27.50 = 577.50 → 578 (round-off +0.50).
  update bills set discount_paise = 4000, discount_reason = 'Regular' where id = bill;
  select * into a from bill_amounts where bill_id = bill;
  if (a.subtotal, a.discount, a.service, a.packaging, a.tax, a.round_off, a.total) <> (54000, 4000, 5000, 0, 2750, 50, 57800) then
    raise exception 'Dine-in maths wrong: %', a;
  end if;

  -- A total the cashier didn't see is refused; so are overpayments and bad methods.
  begin perform add_bill_payment(rid, bill, 'cash', 1000, 99999, null); raise exception 'Stale total accepted';
  exception when others then if sqlerrm not like '%BILL_CHANGED%' then raise; end if; end;
  begin perform add_bill_payment(rid, bill, 'cash', 57801, 57800, null); raise exception 'Overpayment accepted';
  exception when others then if sqlerrm not like '%INVALID_PAYMENT_AMOUNT%' then raise; end if; end;
  begin perform add_bill_payment(rid, bill, 'cheque', 100, 57800, null); raise exception 'Bad method accepted';
  exception when others then if sqlerrm not like '%INVALID_PAYMENT_METHOD%' then raise; end if; end;
  begin perform add_bill_payment('b1111111-1111-1111-1111-111111111111', bill, 'cash', 100, 57800, null); raise exception 'Other restaurant paid it';
  exception when others then if sqlerrm not like '%BILL_CLOSED%' then raise; end if; end;

  -- Split: ₹300 cash, then ₹278 UPI closes it, freezing the amounts.
  st := add_bill_payment(rid, bill, 'cash', 30000, 57800, null);
  if st <> 'open' then raise exception 'Bill closed early'; end if;
  st := add_bill_payment(rid, bill, 'upi', 27800, 57800, null);
  if st <> 'settled' then raise exception 'Bill did not close when paid'; end if;
  if (select (status, subtotal_paise, discount_paise, service_charge_paise, tax_paise, round_off_paise, total_paise) from bills where id = bill)
     <> ('settled'::text, 54000, 4000, 5000, 2750, 50, 57800) then raise exception 'Frozen amounts wrong'; end if;
  if exists (select 1 from orders where bill_id = bill and (payment_status <> 'paid' or settled_at is null)) then raise exception 'Rounds not closed'; end if;
  begin perform add_bill_payment(rid, bill, 'cash', 100, 57800, null); raise exception 'Paid a closed bill';
  exception when others then if sqlerrm not like '%BILL_CLOSED%' then raise; end if; end;
  -- Settings changed later never alter the issued invoice.
  update restaurants set tax_percent = 18 where id = rid;
  if (select total_paise from bills where id = bill) <> 57800 then raise exception 'Issued invoice changed'; end if;
  update restaurants set tax_percent = 5 where id = rid;

  -- Next guests at T7 get a new bill and invoice 2.
  select out_bill_id into bill2 from add_order(rid, t7, null, format('[{"menu_item_id":"%s","qty":1}]', tea)::jsonb, '', 'qr', null);
  if bill2 = bill or (select invoice_no from bills where id = bill2) <> 2 then raise exception 'New guests reused the old bill'; end if;

  -- Takeaway: own bill, packaging ₹20, no service charge. 180 + 20 = 200; GST 10 → 210.
  select out_bill_id into tk from add_order(rid, null, null, format('[{"menu_item_id":"%s","qty":2}]', tea)::jsonb, '', 'staff', null, true, 'Asha', '9876543210');
  select * into a from bill_amounts where bill_id = tk;
  if (select (kind, table_id, customer_name) from bills where id = tk) <> ('takeaway'::text, null::uuid, 'Asha'::text) then raise exception 'Takeaway bill wrong'; end if;
  if (a.subtotal, a.service, a.packaging, a.tax, a.total) <> (18000, 0, 2000, 1000, 21000) then raise exception 'Takeaway maths wrong: %', a; end if;
  perform add_order(rid, null, tk, format('[{"menu_item_id":"%s","qty":1}]', naan)::jsonb, '', 'staff', null);
  if (select count(*) from orders where bill_id = tk) <> 2 then raise exception 'Could not add to the takeaway bill'; end if;

  -- Move T7 → T8; T8 is then busy; T9 merges into T8.
  perform move_bill(rid, bill2, t8);
  if (select table_id from bills where id = bill2) <> t8 or exists (select 1 from orders where bill_id = bill2 and table_id <> t8) then raise exception 'Move failed'; end if;
  select out_bill_id into o from add_order(rid, t9, null, format('[{"menu_item_id":"%s","qty":1}]', paneer)::jsonb, '', 'qr', null);
  begin perform move_bill(rid, o, t8); raise exception 'Moved onto a busy table';
  exception when others then if sqlerrm not like '%TABLE_BUSY%' then raise; end if; end;
  perform mark_order_paid(rid, (select id from orders where bill_id = o), 'upi', null);  -- guest paid their round...
  -- ...which covered the whole T9 bill, so it closed; merging a closed bill is refused.
  if (select status from bills where id = o) <> 'settled' then raise exception 'Paying the only round did not close the bill'; end if;
  select out_bill_id into o from add_order(rid, t9, null, format('[{"menu_item_id":"%s","qty":1}]', paneer)::jsonb, '', 'qr', null);
  perform merge_bills(rid, o, bill2, null);
  if (select status from bills where id = o) <> 'void' or (select count(*) from orders where bill_id = bill2) <> 2 then raise exception 'Merge failed'; end if;
  if exists (select 1 from orders where bill_id = bill2 and table_id <> t8) then raise exception 'Merged rounds not on the target table'; end if;

  -- Cancel 1 of 2 paneer with a reason: order and bill recompute; reason required.
  select i.id into item from order_items i join orders x on x.id = i.order_id where x.bill_id = bill2 and i.name = 'Paneer tikka bowl';
  begin perform cancel_order_item(rid, item, 1, ' ', null); raise exception 'Cancel without reason';
  exception when others then if sqlerrm not like '%REASON_REQUIRED%' then raise; end if; end;
  perform cancel_order_item(rid, item, 1, 'Out of stock', null);
  if exists (select 1 from order_items where id = item) then raise exception 'Fully cancelled line still there'; end if;
  if (select status from orders where id = (select order_id from item_cancellations where reason = 'Out of stock')) <> 'cancelled' then raise exception 'Empty order not cancelled'; end if;
  if (select subtotal from bill_amounts where bill_id = bill2) <> 9000 then raise exception 'Bill did not recompute after cancel'; end if;

  -- Void: refused once paid, allowed otherwise.
  perform add_bill_payment(rid, tk, 'cash', 1000, (select total from bill_amounts where bill_id = tk), null);
  begin perform void_bill(rid, tk, 'Walked out', null); raise exception 'Voided a bill with payments';
  exception when others then if sqlerrm not like '%BILL_HAS_PAYMENTS%' then raise; end if; end;
  perform void_bill(rid, bill2, 'Walked out', null);
  if (select status from bills where id = bill2) <> 'void' or exists (select 1 from orders where bill_id = bill2 and status <> 'cancelled') then raise exception 'Void failed'; end if;

  -- Report for today: two settled bills (578 split + T9's paneer 277 with service charge), one cancellation, one real void.
  rep := sales_report(rid, now() - interval '1 hour', now() + interval '1 hour');
  if (rep->>'bills')::int <> 2 or (rep->>'totalPaise')::int <> 57800 + 27700 or (rep->>'discountPaise')::int <> 4000 then raise exception 'Report totals wrong: %', rep; end if;
  if (rep->>'cancelledItems')::int <> 1 or (rep->>'voidBills')::int <> 1 then raise exception 'Report cancellations/voids wrong: %', rep; end if;
  if (select sum((p->>'amountPaise')::int) from jsonb_array_elements(rep->'payments') p) <> 57800 + 27700 then raise exception 'Payments do not add up: %', rep; end if;
  if rep->'topItems'->0->>'name' <> 'Paneer tikka bowl' then raise exception 'Top item wrong: %', rep; end if;
end $$;

-- Browsers can read their own bills but never call the money functions or the totals view.
do $$ begin
  if has_function_privilege('authenticated', 'add_bill_payment(uuid, uuid, text, integer, integer, uuid)', 'execute')
     or has_function_privilege('anon', 'add_order(uuid, uuid, uuid, jsonb, text, text, uuid, boolean, text, text)', 'execute')
     or has_function_privilege('authenticated', 'place_order(uuid, uuid, jsonb, text)', 'execute')
     or has_table_privilege('authenticated', 'bill_amounts', 'select')
     or has_table_privilege('authenticated', 'bills', 'update') then
    raise exception 'Browsers have write or totals access';
  end if;
  if not has_function_privilege('service_role', 'add_bill_payment(uuid, uuid, text, integer, integer, uuid)', 'execute') then raise exception 'Backend locked out'; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'f2222222-2222-2222-2222-222222222222', true);
do $$ begin if (select count(*) from bills) <> 0 then raise exception 'Non-member can read bills'; end if; end $$;
reset role;

select 'pos: all checks passed' as result;
rollback;
