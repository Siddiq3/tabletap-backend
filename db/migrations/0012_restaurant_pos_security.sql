-- 0012_restaurant_pos_security.sql
-- SUPABASE ONLY. Skip on AWS. Browsers read their own restaurant's bills (for live updates);
-- every write goes through the backend (service role).
alter table bills enable row level security;
alter table bill_payments enable row level security;
alter table item_cancellations enable row level security;

revoke all on bills, bill_payments, item_cancellations from anon, authenticated;
grant select on bills, bill_payments to authenticated;
grant select, insert, update, delete on bills, bill_payments, item_cancellations to service_role;
create policy bills_member_read on bills for select to authenticated using (is_member(restaurant_id));
create policy bill_payments_member_read on bill_payments for select to authenticated using (is_member(restaurant_id));

-- The view would bypass row security, so only the backend may read it.
revoke all on bill_amounts from anon, authenticated;
grant select on bill_amounts to service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'next_invoice_no(uuid)',
    'open_table_bill(uuid, uuid)',
    'add_order(uuid, uuid, uuid, jsonb, text, text, uuid, boolean, text, text)',
    'close_bill(uuid, text, uuid)',
    'add_bill_payment(uuid, uuid, text, integer, integer, uuid)',
    'mark_order_paid(uuid, uuid, text, uuid)',
    'move_bill(uuid, uuid, uuid)',
    'merge_bills(uuid, uuid, uuid, uuid)',
    'void_bill(uuid, uuid, text, uuid)',
    'cancel_order_item(uuid, uuid, integer, text, uuid)',
    'sales_report(uuid, timestamptz, timestamptz)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
-- place_order was recreated in 0011; keep it backend-only as in 0002.
revoke execute on function place_order(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function place_order(uuid, uuid, jsonb, text) to service_role;

alter publication supabase_realtime add table bills, bill_payments;
