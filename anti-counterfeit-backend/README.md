# Anti-Counterfeit QR Verification System

A cryptographically signed QR code system for authenticating physical merchandise.

## How it works
1. Generate an RS256 keypair (`generate-keys.mjs`)
2. Backend (`index.js`) signs a JWT for each product and encodes a verification URL into a QR code
3. Scanning the QR hits `/verify-token`, which checks the signature and logs the scan in Postgres
4. Every scan is tracked — total scans, risk level, IP, timestamp — for fraud detection

## Stack
- Node.js / Express backend
- PostgreSQL for products + verification history (schema: `database-setup.sql`)
- JWT (RS256) for tamper-proof signing
- `qrcode` + `canvas` for QR generation, with optional logo overlay

## Local setup
```
npm install
node generate-keys.mjs
$env:PRIVATE_KEY = Get-Content private.pem -Raw
$env:PUBLIC_KEY = Get-Content public.pem -Raw
$env:DATABASE_URL = "your-postgres-connection-string"
npm start
```

## Deployment
- Hosted on Render, pointed at `verify.myproductauth.com` via the `CNAME` file
- Set `PRIVATE_KEY`, `PUBLIC_KEY`, and `DATABASE_URL` as environment variables in Render — never commit keys
- Run `database-setup.sql` once against your Postgres instance to create tables/views

## Endpoints
- `POST /sign-qr` — generate a signed QR code (no logo)
- `POST /sign-qr-with-logo` — generate a signed QR code with a logo overlay
- `POST /verify-token` — verify a scanned token, logs the scan
- `GET /products` — list tracked products
- `GET /verifications` — scan history
- `GET /analytics/overview` — summary stats
- `GET /export/products?key=YOUR_EXPORT_KEY&format=json|csv` — full backup of every product (includes the QR image and signed token)
- `GET /export/verifications?key=YOUR_EXPORT_KEY&format=json|csv` — full backup of every scan/verification event

## Security model
- `ADMIN_KEY` (env var, required): protects QR generation, product activate/deactivate, product lists, verification history, and analytics. Sent as an `x-admin-key` header. `generate.html` and `admin.html` prompt for it once per browser session. **Without this set, those endpoints are disabled entirely.**
- `EXPORT_KEY` (env var): protects the backup export endpoints (passed as `?key=` in the URL).
- `/verify-token` is intentionally public (customers must verify), but rate-limited to 30 requests/min per IP.
- All admin endpoints are rate-limited (60/min per IP); exports 5/min per IP.
- CORS is locked to `https://verify.myproductauth.com` (override with an `ALLOWED_ORIGINS` env var, comma-separated, if ever needed).
- The health check at `/` no longer lists available endpoints.
- Use different random strings for `ADMIN_KEY` and `EXPORT_KEY`. Store both in a password manager alongside your `.pem` files.

## Blockchain inscription (Doginals) — the final, permanent step
Each product can be anchored on the Dogecoin blockchain. Do this ONLY when a product's details are locked and final — inscriptions cannot be edited or removed, ever.

**Also do once, before any products:** inscribe the contents of `public.pem` as a text inscription. This creates a permanent, independent anchor for your entire verification system — anyone can verify your tokens against the on-chain public key forever, even if all your servers disappear. Save that inscription ID somewhere prominent.

Per-product workflow (after generating the product's QR):
1. Get the manifest: `GET /products/:id/manifest` (with `x-admin-key` header). Copy the `inscribeThis` string exactly.
2. Inscribe it as plain text using a Doginals inscription service (e.g. Doge Labs at drc-20.org/inscribe or doggy.market). Cost is roughly a couple of DOGE per inscription. Do a cheap test inscription first if it's your first time.
3. Copy the resulting inscription ID from the service/explorer.
4. Record it: `POST /products/:id/inscription` with JSON body `{"inscriptionId":"<id>"}` (with `x-admin-key` header). This is write-once — the API refuses to overwrite an existing inscription ID.
5. Customers scanning that product now see an "⛓️ Inscribed on Dogecoin" badge with a link to the permanent on-chain record.

Migration note: existing databases need `migration-add-inscription.sql` run once in Supabase's SQL Editor.

## Backups (important if tagging real merchandise)
- Set an `EXPORT_KEY` environment variable in Render — a long random string only you know. Without it, the export endpoints are disabled.
- Periodically download a backup:
  ```
  https://your-backend.onrender.com/export/products?key=YOUR_EXPORT_KEY&format=json
  ```
  Save the file somewhere outside of Render/Supabase entirely (cloud drive, external storage).
- **Never rotate `PRIVATE_KEY`/`PUBLIC_KEY` after tagging real merchandise** — doing so permanently invalidates every QR code already printed. Back up both `.pem` files somewhere secure and durable (password manager, encrypted drive) and treat them as permanent for this product line.
- On Supabase, the free tier has no automatic backups and pauses projects after 7 days of inactivity — upgrade to Pro before relying on this for real inventory.
