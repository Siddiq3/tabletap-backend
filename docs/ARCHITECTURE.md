# Architecture

Goal: move from Supabase to AWS (or anything else) later **without losing data and without rewriting web or app**.

```
tabletap-web (Next.js) ─┐                        ┌─ src/adapters/supabase  (today)
                        ├─► tabletap-backend API ┤
tabletap-app (Expo) ────┘   checks login + role  └─ src/adapters/aws       (later)
                                                           │
                                                           ▼
                                            PostgreSQL (db/migrations)
```

All three repos carry identical `src/contract/` files: types, money/order rules and the typed API client.

## The rules

1. **Only the backend touches the database.** Web and app call the API through `createApiClient` in `src/contract/api.ts`.
2. **Data is plain PostgreSQL.** `0001_core_schema.sql` runs on Supabase, AWS RDS/Aurora and Neon. Supabase-only security is isolated in `0002_supabase_security.sql`.
3. **Money logic lives in the database.** `place_order()` and `create_restaurant()` are SQL functions, so prices and order numbers are identical on any backend.
4. **The API enforces access in code.** Every route resolves the staff member's restaurant from their login and filters by it.
5. **Two small client files per provider.** In web and app, only `lib/auth.ts` (login) and `lib/feed.ts` (live order signal) know about Supabase.

## Moving to AWS

1. Create RDS/Aurora PostgreSQL in `ap-south-1` (Mumbai).
2. Copy data: `pg_dump` from Supabase → `pg_restore` into RDS. Nothing is converted.
3. Logins: export Supabase Auth users into Cognito, keeping the same user ids (stored in `restaurant_members.user_id`).
4. Backend: add `src/adapters/aws/` (a `pg` client implementing `Repos`, a Cognito `AuthVerifier`), set `DATA_BACKEND=aws`. Host on ECS/Lightsail, or Lambda via `hono/aws-lambda`.
5. Web and app: swap `lib/auth.ts` to Cognito and `lib/feed.ts` to API Gateway WebSockets or AppSync.
6. Test on staging, then switch production.
