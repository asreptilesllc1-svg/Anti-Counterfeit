# ProductAuth — Multi-Tenant Anti-Counterfeit QR Verification

A self-serve SaaS for signing, tracking, and verifying physical/digital product authenticity via QR codes, with optional permanent blockchain inscription.

## Architecture
- **Node.js / Express** backend, one shared signing keypair for the whole platform
- **PostgreSQL** (Supabase) with full multi-tenant isolation — every account's products, verifications, and audit log entries are scoped by `account_id`, enforced server-side on every query
- **Stripe** for billing (subscriptions, webhooks)
- **JWT (RS256)** signs every product token; a token embeds which account owns it, so verification can look up that account's branding and data without any per-customer keys
- IP-based location lookup on every scan (best-effort, never blocks verification if it fails)

## Accounts and isolation
Each customer:
- Signs up with email + password (`/signup`) — password hashed with scrypt, never stored in plaintext
- Gets their own `api_key`, used in the `x-api-key` header for every authenticated request
- Can only ever see/modify their own products and verifications — every query is filtered by their `account_id`
- Has a `plan_product_limit` enforced server-side before any QR can be generated past their monthly quota
- Can set their own `business_name`, `brand_logo_url`, and `brand_color` — these are returned by `/verify-token` and rendered live on the shared `verify.html` page, so each customer's verification page looks like their own brand without needing a separate deployed page per customer

## Setup

### 1. Database
Fresh install: run `database-setup.sql` in Supabase's SQL Editor.
Upgrading an existing single-tenant install: run `migration-multitenant.sql` instead — it preserves existing data by migrating it into a "legacy" account, and fixes a critical constraint (`product_id` must be unique **per account**, not globally, or two customers naming a product the same SKU would collide).

### 2. Signing keys
```
node generate-keys.mjs
```
Set `PRIVATE_KEY` and `PUBLIC_KEY` in Render from the generated `.pem` files. **Never rotate these once real customers have printed QR codes** — doing so invalidates every code already in the world.

### 3. Environment variables (Render)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Supabase/Postgres connection string |
| `PRIVATE_KEY` / `PUBLIC_KEY` | Platform signing keypair |
| `ADMIN_KEY` | Your own superadmin key (cross-account operations only — not used by customers) |
| `EXPORT_KEY` | Your own platform-wide backup export key |
| `ALLOWED_ORIGINS` | Comma-separated allowed origins for CORS (defaults to `verify.myproductauth.com`) |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_GROWTH` / `STRIPE_PRICE_BUSINESS` | Stripe Price IDs for each plan |

### 4. Stripe setup
1. In Stripe, create three recurring Prices (Starter/Growth/Business) under one Product (or three Products — either works)
2. Copy each Price ID into the env vars above
3. Add a webhook endpoint pointing to `https://your-backend.onrender.com/webhooks/stripe`, subscribed to: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
4. Copy the webhook signing secret into `STRIPE_WEBHOOK_SECRET`

## Endpoints

### Public (no auth)
- `GET /` — health check
- `POST /signup` — create an account
- `POST /login` — get your API key
- `POST /verify-token` — customer-facing verification, rate-limited

### Authenticated (`x-api-key` header)
- `POST /sign-qr`, `POST /sign-qr-with-logo` — generate a signed QR (blocked once you hit your plan's monthly limit)
- `GET /products`, `GET /products/:id`, `POST /products/:id/activate|deactivate`
- `GET /products/:id/manifest`, `POST /products/:id/inscription` — blockchain inscription tools
- `GET /verifications`, `GET /analytics/overview`, `GET /analytics/by-date`, `GET /analytics/by-product`
- `GET /export/products`, `GET /export/verifications` — your own data, JSON or CSV
- `GET /account/me`, `POST /account/branding`, `POST /account/regenerate-key`
- `POST /billing/checkout`, `POST /billing/portal` — Stripe subscription management

### Superadmin (`x-admin-key` header — you, not customers)
- `GET /admin/export/all` — full cross-account backup

## What's honestly still missing
This backend now backs every claim on the marketing page truthfully — real quotas, real per-tenant branding, real location tracking. Still ahead, not yet built:
- A polished self-serve billing UI inside the dashboard (checkout currently needs to be triggered via API call)
- A dedicated onboarding flow guiding a new signup through their first QR code
- Admin-side account management UI (currently API-only via `/admin/export/all` and direct DB access)
