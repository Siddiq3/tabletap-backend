# GitHub branches

Tabletap is three repos: `tabletap-backend`, `tabletap-web`, `tabletap-app`. Each uses the same branch plan.

## Permanent branches (in every repo)

| Branch    | Deploys to | Rule |
|-----------|------------|------|
| `main`    | Production | Only merges from `develop` or `hotfix/*`. Protected: pull request required. |
| `develop` | Staging (separate Supabase project, Vercel preview, test API) | Feature branches merge here first. |

## Feature branches (from `develop`)

Use the **same branch name in every repo the feature touches**, so the pieces are easy to match up:

1. `feature/foundation` – first version: API, guest menu, dashboard, staff app
2. `feature/billing-kot` – table bills, KOT and bill printing
3. `feature/payments` – Razorpay per restaurant, payment webhooks, auto "Paid"
4. `feature/subscriptions` – plans, trial expiry, Razorpay Subscriptions
5. `feature/staff-roles` – invite staff, kitchen/cashier/waiter screens
6. `feature/analytics` – sales reports, top dishes, peak hours
7. `feature/admin-panel` – your panel for all restaurants

Urgent production fix: `hotfix/<short-name>` from `main`, merged into both `main` and `develop`.

## Release order when the API changes

1. Merge and deploy **tabletap-backend** first. New fields should be optional so old web and app versions keep working.
2. Then **tabletap-web**.
3. Then **tabletap-app** (Play Store updates take days to reach everyone, so the backend must support the previous app version for a while).

## The contract files

`src/contract/` (types, rules, API client) is copied into all three repos. Rules:

- Change it in **tabletap-backend first**, then copy the same files into web and app in that feature's branch.
- Bump `CONTRACT_VERSION` in `src/contract/index.ts` in all three.
- `GET /health` on the backend returns `contractVersion`; check it matches before releasing web or app.

## Database changes

Live in `tabletap-backend/db/migrations/`. Never edit an old migration; add a new numbered file in the same pull request as the code that needs it.
