# Tabletap Backend

API server for Tabletap, the QR ordering SaaS for restaurants. Node + Hono, PostgreSQL (Supabase today).
It's the only part of Tabletap that talks to the database. Web: `tabletap-web`. Staff app: `tabletap-app`.

## What it does

- Guest routes (no login): menu by restaurant link and table, place order (15/min per phone), order tracking
- Owner signup: creates restaurant, owner, and tables in one transaction
- Staff routes (login token + role checked): live orders board, move order status, mark Cash/UPI paid, menu management, tables
- Each restaurant only sees its own data; prices and GST are always computed in the database

## Setup

1. Create a Supabase project (Mumbai region).
2. SQL Editor: run `db/migrations/0001_core_schema.sql`, then `0002_supabase_security.sql`.
3. Authentication → Email Templates → "Magic Link": include `{{ .Token }}` so people get a 6-digit login code.
4. `cp .env.example .env` and fill it in.
5. `npm install` then `npm run dev` → http://localhost:4000/health

## Deploy

Any Node host (Render, Railway, AWS Lightsail/ECS): build `npm run build`, start `npm start`.
Set `CORS_ORIGINS` to your web domain(s).

## Folders

```
db/migrations/      plain PostgreSQL; 0002 is Supabase-only security
src/app.ts          all API routes
src/ports.ts        what the API needs from storage and login
src/adapters/       Supabase today; add aws/ later
src/contract/       shared with web and app (keep the three copies identical)
docs/               ARCHITECTURE.md, BRANCHING.md
```

## Backups

`npm run db:backup` writes a full `pg_dump` that restores into any PostgreSQL, including AWS RDS.
