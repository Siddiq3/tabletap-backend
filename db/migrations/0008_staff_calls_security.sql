-- SUPABASE ONLY. Guests write through the API; staff can read their own restaurant's alerts.
alter table staff_calls enable row level security;
revoke all on staff_calls from anon, authenticated;
grant select on staff_calls to authenticated;
grant select, insert, update, delete on staff_calls to service_role;
create policy staff_calls_member_read on staff_calls for select to authenticated using (is_member(restaurant_id));
revoke execute on function request_staff_call(uuid, uuid) from public, anon, authenticated;
grant execute on function request_staff_call(uuid, uuid) to service_role;
alter publication supabase_realtime add table staff_calls;
