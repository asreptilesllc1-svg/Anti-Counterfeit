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

### 5. Email (Brevo)
1. Sign up at [brevo.com](https://www.brevo.com) with a **fresh account** (not shared with any other project/domain) — free tier is 300 emails/day, no domain-count limit
2. Add and verify your domain (`myproductauth.com`) under Senders & Domains — this means adding a few DNS records (SPF/DKIM) at your domain registrar (Namecheap)
3. Create an API key (SMTP & API → API Keys), set `BREVO_API_KEY` in Render
4. Optionally set `EMAIL_FROM` (defaults to `hello@myproductauth.com`) and `EMAIL_FROM_NAME` (defaults to `ProductAuth`) — the from-address must be on your verified domain
5. Without `BREVO_API_KEY` set, the backend still runs fine — verification/reset emails just get logged to the console instead of sent, so nothing breaks in the meantime

**Separately:** for `hello@myproductauth.com` to actually receive mail people send *to* it (not just send *from* it), set up email forwarding at your domain registrar (Namecheap has a free email forwarding feature) pointing to your real inbox. Sending (via Brevo) and receiving (via forwarding) are two separate things to configure.

## Bot / abuse protection
- **Honeypot field**: signup and forgot-password forms include a hidden `website` input, invisible to real users but auto-filled by unsophisticated bots. Any value there triggers a silent fake-success response (no account created, no email sent) rather than an error, so bots don't learn to adapt.
- **Tighter rate limiting on email-sending endpoints**: `/signup` and `/forgot-password` are capped at 5 requests/hour per IP (separate, stricter limit than general auth endpoints), since each request sends a real email through your Brevo quota.
- **Disposable email blocking**: signups from known temporary-email domains (Mailinator, Guerrilla Mail, etc.) are rejected with a clear message.
- **Not yet added, worth considering if bot traffic becomes a real problem**: Cloudflare Turnstile (free, invisible CAPTCHA) on signup/forgot-password for stronger protection against more sophisticated bots that fill honeypot fields correctly.

## Pricing tiers — what's actually gated, verified against the code
| Feature | Free | Starter | Growth | Business |
|---|---|---|---|---|
| Products | 5 total (lifetime) | 50/mo | 250/mo | 1,500/mo |
| Verification, scan history, risk flags | ✅ | ✅ | ✅ | ✅ |
| Data export (own data only) | ✅ | ✅ | ✅ | ✅ |
| Branding (name, logo, color) | ❌ | ✅ | ✅ | ✅ |
| Logo embedded on QR codes | ❌ | ❌ | ✅ | ✅ |
| Advanced analytics (trends, top products) | ❌ | ❌ | ✅ | ✅ |
| Blockchain inscription | ❌ | ❌ | ❌ | ✅ |
| API rate limit | 60/min | 60/min | 60/min | 300/min |
| Support quality | Same for everyone, every tier |

Every row here is enforced by `requirePlan(...)` in the code, not just marketing copy — verified deliberately so nothing advertised is aspirational.

## Endpoints

### Public (no auth)
- `GET /` — health check
- `POST /signup` — create an account (sends a verification email)
- `POST /login` — get your API key
- `POST /verify-email` — confirm email from the link sent at signup
- `POST /forgot-password` — request a password reset email
- `POST /reset-password` — set a new password from a reset link
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
- `GET /admin/overview` — total accounts, plan breakdown, estimated MRR, recent signups, verification volume
- `GET /admin/accounts` — full account list, searchable by email/business name
- `POST /admin/accounts/:id/activate` / `deactivate` — manage any customer account directly
- `GET /admin/export/all` — full cross-account backup (also requires `EXPORT_KEY`)

**`owner-dashboard.html`** is your own private view of the platform — not linked from anywhere customers can see, gated by your `ADMIN_KEY`. This is separate from `admin.html`, which despite the name is actually your *customers'* dashboard (each showing only their own data). Bookmark `owner-dashboard.html` somewhere private; don't link to it from the public site.

Note on the MRR figure: it's estimated from account records (plan × price for active/trialing accounts), not pulled live from Stripe. It'll be exactly right once Stripe billing is fully wired up and driving `subscription_status`, since Stripe is the actual source of truth for real charges.

## What's honestly still missing
This backend now backs every claim on the marketing page truthfully — real quotas, real per-tenant branding, real location tracking. Still ahead, not yet built:
- A polished self-serve billing UI inside the dashboard (checkout currently needs to be triggered via API call)
- A dedicated onboarding flow guiding a new signup through their first QR code
- Admin-side account management UI (currently API-only via `/admin/export/all` and direct DB access)
