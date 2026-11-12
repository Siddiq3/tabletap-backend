-- 0010_table_bills_security.sql
-- SUPABASE ONLY. Skip on AWS. Only the backend (service role) may settle bills.
revoke execute on function settle_table_bill(uuid, uuid, uuid[], text, uuid) from public, anon, authenticated;
grant execute on function settle_table_bill(uuid, uuid, uuid[], text, uuid) to service_role;
