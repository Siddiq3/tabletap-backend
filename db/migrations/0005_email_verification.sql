-- 0005_email_verification.sql
-- Portable PostgreSQL. Owners who sign up with an email verify it with a 6-digit code.
-- Existing profiles stay unverified on purpose: they verify on their next login.

alter table user_profiles add column email_verified_at timestamptz;

-- Changing the email always needs a new verification, whichever code path changes it.
create or replace function reset_email_verification() returns trigger
language plpgsql as $$
begin
  if new.email is distinct from old.email then
    new.email_verified_at = null;
  end if;
  return new;
end $$;

create trigger user_profiles_email_changed before update of email on user_profiles
  for each row execute function reset_email_verification();

-- One row per code sent; only the newest counts. Older rows stay a day so resends per hour can be counted.
create table email_verification_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,  -- user_profiles.user_id; no FK, same as restaurant_members
  code_hash  text not null,  -- scrypt "salt:hash"; never the code
  expires_at timestamptz not null,
  attempts   smallint not null default 0,
  created_at timestamptz not null default now()
);
create index email_verification_codes_user_idx on email_verification_codes(user_id, created_at desc);

-- claim_verification_attempt: atomically count one attempt on the newest live code before checking it,
-- so parallel guesses can't get past the 5-attempt limit. No row = no code, expired, or used up.
create or replace function claim_verification_attempt(p_user_id uuid)
returns table (out_code_hash text, out_attempts_left integer)
language sql as $$
  update email_verification_codes c
     set attempts = c.attempts + 1
   where c.id = (
           select id from email_verification_codes
            where user_id = p_user_id
            order by created_at desc
            limit 1
         )
     and c.expires_at > now()
     and c.attempts < 5
  returning c.code_hash, 5 - c.attempts;
$$;
