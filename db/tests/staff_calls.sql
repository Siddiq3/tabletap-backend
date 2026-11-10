-- Run on a disposable database after migrations 0001-0008. Everything rolls back.
begin;
insert into restaurants(id, slug, name) values('a1111111-1111-1111-1111-111111111111', 'calls-test-a', 'Calls test A'), ('b1111111-1111-1111-1111-111111111111', 'calls-test-b', 'Calls test B');
insert into restaurant_members(restaurant_id, user_id, role) values('a1111111-1111-1111-1111-111111111111', 'a2222222-2222-2222-2222-222222222222', 'owner');
insert into dining_tables(id, restaurant_id, label, is_active) values
 ('a3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', '7', true),
 ('b3333333-3333-3333-3333-333333333333', 'b1111111-1111-1111-1111-111111111111', '8', true),
 ('c3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', '9', false);
do $$
declare a uuid; b uuid;
begin
 a := request_staff_call('a1111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333');
 b := request_staff_call('a1111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333');
 if a <> b or (select count(*) from staff_calls) <> 1 then raise exception 'Duplicate call was created'; end if;
 begin perform request_staff_call('a1111111-1111-1111-1111-111111111111', 'b3333333-3333-3333-3333-333333333333'); raise exception 'Foreign table was accepted'; exception when others then if sqlerrm not like '%INVALID_TABLE%' then raise; end if; end;
 begin perform request_staff_call('a1111111-1111-1111-1111-111111111111', 'c3333333-3333-3333-3333-333333333333'); raise exception 'Inactive table was accepted'; exception when others then if sqlerrm not like '%INVALID_TABLE%' then raise; end if; end;
 update staff_calls set resolved_at = now() where id = a;
 begin perform request_staff_call('a1111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333'); raise exception 'Cooldown was bypassed'; exception when others then if sqlerrm not like '%STAFF_CALL_COOLDOWN%' then raise; end if; end;
 update staff_calls set created_at = now() - interval '1 minute' where id = a;
 b := request_staff_call('a1111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333');
 if a = b then raise exception 'Resolved call was reused'; end if;
 update restaurants set plan = 'suspended' where id = 'a1111111-1111-1111-1111-111111111111';
 begin perform request_staff_call('a1111111-1111-1111-1111-111111111111', 'a3333333-3333-3333-3333-333333333333'); raise exception 'Suspended restaurant was accepted'; exception when others then if sqlerrm not like '%RESTAURANT_UNAVAILABLE%' then raise; end if; end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', 'a2222222-2222-2222-2222-222222222222', true);
do $$ begin if (select count(*) from staff_calls) <> 2 then raise exception 'Own restaurant calls not readable'; end if; end $$;
select set_config('request.jwt.claim.sub', 'b2222222-2222-2222-2222-222222222222', true);
do $$ begin if (select count(*) from staff_calls) <> 0 then raise exception 'Tenant isolation failed'; end if;
 if has_table_privilege(current_user, 'staff_calls', 'insert') or has_table_privilege(current_user, 'staff_calls', 'update') then raise exception 'Direct writes are allowed'; end if;
 if has_function_privilege(current_user, 'request_staff_call(uuid,uuid)', 'execute') then raise exception 'Direct guest RPC is allowed'; end if;
end $$;
reset role;
rollback;
