# Tabletap Backend

API server for Tabletap, the QR ordering SaaS for restaurants. Node + Hono, PostgreSQL (Supabase today).
It's the only part of Tabletap that talks to the database. Web: `tabletap-web`. Staff app: `tabletap-app`.

## What it does

- Guest routes (no login): menu by restaurant link and table, place order (15/min per phone), order tracking
- Owner signup: creates restaurant, owner, and tables in one transaction
- Login routes: owner/manager signup and login with email, phone or username + password (5 tries / 10 min), forgot password
- Staff routes (login token + role checked): live orders board, move order status, mark Cash/UPI paid, menu management, tables
- Staff PINs: owner adds staff (no account) with a PIN; on a shared device they unlock with `/staff/pin-session` and send `X-Staff-Session`, so their role applies and orders record who paid/moved them
- Each restaurant only sees its own data; prices and GST are always computed in the database

## Setup

1. Create a Supabase project (Mumbai region).
2. SQL Editor: run `db/migrations/` in order (0001 → 0004). 0002 and 0004 are Supabase-only security.
3. Authentication → URL Configuration → Redirect URLs: add `PASSWORD_RESET_URL` (the web's `/reset-password`).
4. `cp .env.example .env` and fill it in.
5. `npm install` then `npm run dev` → http://localhost:4000/health

## Deploy

Any Node host (Render, Railway, AWS Lightsail/ECS): build `npm run build`, start `npm start`.
Set `CORS_ORIGINS` to your web domain(s).

## Folders

```
db/migrations/      plain PostgreSQL; 0002 and 0004 are Supabase-only security
src/app.ts          all API routes
src/ports.ts        what the API needs from storage and login
src/adapters/       Supabase today; add aws/ later
src/contract/       shared with web and app (keep the three copies identical)
docs/               ARCHITECTURE.md, BRANCHING.md
```

## Backups

`npm run db:backup` writes a full `pg_dump` that restores into any PostgreSQL, including AWS RDS.
