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
2. SQL Editor: run `db/migrations/` in order (0001 → 0012). 0002, 0004, 0006, 0008, 0010 and 0012 are Supabase-only security.
3. Authentication → URL Configuration → Redirect URLs: add `PASSWORD_RESET_URL` (the web's `/reset-password`).
4. `cp .env.example .env` and fill it in.
5. `npm install` then `npm run dev` → http://localhost:4000/health

## Deploy

Any Node host (Render, Railway, AWS Lightsail/ECS): build `npm run build`, start `npm start`.
Set `CORS_ORIGINS` to your web domain(s).

## Folders

```
db/migrations/      plain PostgreSQL; 0002, 0004, 0006, 0008, 0010 and 0012 are Supabase-only security
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

## Bills, payments and reports

Apply migrations through `0012`. Contract version is 8 in all three clients. All money maths lives in the `bill_amounts` view (migration 0011); `computeBillAmounts` in the contract mirrors it for previews and the demo, and `src/pos.test.ts` checks both give the same numbers as `db/tests/pos.sql`.

- **Bills.** One per table visit or takeaway, with an invoice number from `restaurants.invoice_seq`. Guest QR orders (`place_order`, unchanged signature) and staff orders (`add_order`) join the table's open bill; orders record `source` (`qr`/`staff`) and who placed them.
- **Money.** taxable = subtotal − discount + service charge (dine-in, `service_charge_percent`) + packaging (takeaway, `packaging_paise`); GST on taxable, split CGST/SGST on the invoice; total rounded to the rupee. Closing a bill freezes the amounts, so later setting changes never alter an issued invoice.
- **Payments.** `POST /staff/bills/:id/payments` `{ method, amountPaise, expectedTotalPaise }` (owner, manager, cashier). Several payments make a split; the bill closes when covered. A total the cashier didn't see is refused with 409 `BILL_CHANGED`. The old per-order "paid" buttons go through `mark_order_paid`; the last unpaid round settles whatever is left.
- **Staff orders.** `POST /staff/orders` with exactly one of `tableId`, `billId` or `takeaway: { customerName?, customerPhone? }` (owner, manager, cashier, waiter).
- **Bill actions.** `GET /staff/bills`, `GET /staff/bills/:id`, `PATCH /staff/bills/:id` (discount with reason, service charge on/off; managers), `POST …/move { tableId }`, `POST …/merge { intoBillId }`, `POST …/void { reason }` (managers, only without payments), `POST /staff/order-items/:id/cancel { qty, reason }` (managers).
- **Reports.** `GET /staff/reports/sales?from&to` (managers, up to ~3 months): bills, dine-in/takeaway, sales, discounts, charges, GST, round-off, payments by method, top dishes, cancellations, voids, invoice range. A single day is the day close.
- **Settings.** `PATCH /staff/restaurant` also takes `gstin`, `fssai`, `serviceChargePercent`, `packagingPaise`. With a GSTIN, bills print as tax invoices.
- **Guests.** `GET /public/r/:slug/orders/:id/bill` returns the guest's open bill (all rounds) so they pay once; nothing once it is closed.

Tests: `src/pos.test.ts` (maths parity, permissions, validation) and `db/tests/pos.sql` (invoice numbers, rounds, discount/service/packaging/GST/round-off, split payments, stale totals, move/merge/void, cancellations, sales report, browser privileges; run after 0001–0012, rolls back). `0011` also turns orders left open by `0009` into bills, with paid rounds recorded as payments.
