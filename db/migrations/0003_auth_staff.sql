-- 0003_auth_staff.sql
-- Portable PostgreSQL. Password logins for owners/managers, PIN-only staff on shared devices.

-- ---------- owner/manager login profiles (user_id = id from the login provider, no FK) ----------
create table user_profiles (
  user_id    uuid primary key,
  full_name  text not null check (char_length(full_name) between 1 and 80),
  username   text not null unique check (username ~ '^[a-z0-9_.]{3,30}$' and username ~ '[a-z]'),  -- a letter, so it can't look like a phone
  email      text unique check (email = lower(email)),
  phone      text unique check (phone ~ '^\+91[6-9][0-9]{9}$'),
  created_at timestamptz not null default now(),
  check (email is not null or phone is not null)
);

-- ---------- staff without an account: name + PIN, used on an owner/manager's device ----------
create table staff_members (
  id                  uuid primary key default gen_random_uuid(),
  restaurant_id       uuid not null references restaurants(id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 40),
  role                text not null check (role in ('manager','cashier','kitchen','waiter')),
  pin_hash            text not null,  -- scrypt "salt:hash" (hex); never the PIN
  failed_pin_attempts smallint not null default 0,
  locked_until        timestamptz,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);
create index staff_members_restaurant_idx on staff_members(restaurant_id);

create table staff_sessions (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid not null references staff_members(id) on delete cascade,
  token_hash text not null unique,  -- sha256 of the random token; the token itself is never stored
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index staff_sessions_staff_idx on staff_sessions(staff_id);

-- ---------- who did what (null = owner/manager acting with their own login) ----------
alter table orders
  add column status_changed_by_staff_id uuid references staff_members(id) on delete set null,
  add column paid_by_staff_id           uuid references staff_members(id) on delete set null;

-- ---------- claim_pin_attempt: atomically count a PIN attempt before checking it ----------
-- Counting first (in one statement, under the row lock) means parallel guesses can't all slip
-- past the lockout. Returns no row when the staff member is unknown, inactive or locked.
-- The 5th attempt sets a 5-minute lock; a correct PIN resets the counter (done by the API).
create or replace function claim_pin_attempt(p_staff_id uuid)
returns table (out_pin_hash text, out_restaurant_id uuid)
language sql as $$
  update staff_members
     set failed_pin_attempts = case when failed_pin_attempts + 1 >= 5 then 0 else failed_pin_attempts + 1 end,
         locked_until        = case when failed_pin_attempts + 1 >= 5 then now() + interval '5 minutes' else null end
   where id = p_staff_id
     and is_active
     and (locked_until is null or locked_until <= now())
  returning pin_hash, restaurant_id;
$$;
