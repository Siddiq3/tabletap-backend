-- 0004_supabase_security.sql
-- SUPABASE ONLY. Skip on AWS. RLS on with no policies: only the backend's service role reads these.

alter table user_profiles  enable row level security;
alter table staff_members  enable row level security;
alter table staff_sessions enable row level security;

revoke execute on function claim_pin_attempt(uuid) from public, anon, authenticated;
