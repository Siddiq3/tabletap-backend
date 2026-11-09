-- 0006_supabase_security.sql
-- SUPABASE ONLY. Skip on AWS. RLS on with no policies: only the backend's service role reads it.

alter table email_verification_codes enable row level security;

revoke execute on function claim_verification_attempt(uuid) from public, anon, authenticated;
