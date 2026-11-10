# Tabletap Backend

API server for Tabletap, the QR ordering SaaS for restaurants. Node + Hono, PostgreSQL (Supabase today).
It's the only part of Tabletap that talks to the database. Web: `tabletap-web`. Staff app: `tabletap-app`.

## What it does

- Guest routes (no login): menu by restaurant link and table, place order (15/min per phone), order tracking
- Owner signup: creates restaurant, owner, and tables in one transaction
- Login routes: owner/manager signup and login with email, phone or username + password (5 tries / 10 min), forgot password
- Email verification: signing up with an email sends a 6-digit code (Resend); until it's entered, staff and restaurant routes answer 403 `EMAIL_UNVERIFIED`
- Staff routes (login token + role checked): live orders board, move order status, mark Cash/UPI paid, menu management, tables
- Staff PINs: owner adds staff (no account) with a PIN; on a shared device they unlock with `/staff/pin-session` and send `X-Staff-Session`, so their role applies and orders record who paid/moved them
- Each restaurant only sees its own data; prices and GST are always computed in the database

## Setup

1. Create a Supabase project (Mumbai region).
2. SQL Editor: run `db/migrations/` in order (0001 → 0008). 0002, 0004, 0006 and 0008 are Supabase-only security.
3. Authentication → URL Configuration → Redirect URLs: add `PASSWORD_RESET_URL` (the web's `/reset-password`).
4. `cp .env.example .env` and fill it in.
5. `npm install` then `npm run dev` → http://localhost:4000/health

## Deploy

Any Node host (Render, Railway, AWS Lightsail/ECS): build `npm run build`, start `npm start`.
Set `CORS_ORIGINS` to your web domain(s).

## Folders

```
db/migrations/      plain PostgreSQL; 0002, 0004, 0006 and 0008 are Supabase-only security
src/app.ts          all API routes
src/ports.ts        what the API needs from storage and login
src/adapters/       Supabase today; add aws/ later
src/contract/       shared with web and app (keep the three copies identical)
docs/               ARCHITECTURE.md, BRANCHING.md
```

## Backups

`npm run db:backup` writes a full `pg_dump` that restores into any PostgreSQL, including AWS RDS.

## Guest calls for assistance

Apply `0007_staff_calls.sql` followed by `0008_staff_calls_security.sql` in Supabase before using this feature. 0007 is portable PostgreSQL; 0008 sets Supabase RLS, grants and realtime publication. API contract version is 5 in all three clients.

- `POST /public/r/:slug/staff-calls` with `{ tableId }` creates a call for an active table. Guests need the table QR; menu-only viewers cannot call. Suspended restaurants and foreign/inactive tables are rejected.
- A database row lock and partial unique index keep one pending call per table. A new call after handling has a 30-second cooldown measured from the preceding request. The public endpoint also allows at most 10 requests per IP per minute.
- `GET /staff/calls` lists pending calls for the authenticated restaurant. `POST /staff/calls/:id/resolve` marks a call handled and records the active PIN staff member when present. The existing verified-account, membership and PIN-session checks apply. Direct browser writes and cross-restaurant reads are denied by RLS.
- Web and mobile orders screens subscribe to changes and use a 5-second polling fallback. The web has an **Enable call sound** control; mobile vibrates on new call IDs. These are foreground alerts, not background push notifications.

Tests: `node --import tsx --test src/*.test.ts`. `db/tests/staff_calls.sql` exercises duplicate prevention, table validation, cooldown, restaurant suspension and RLS after all migrations on a disposable PostgreSQL database; it rolls back its test rows. The local test run also verified 20 concurrent requests produce one pending call. Real Supabase realtime delivery requires configured project credentials.
