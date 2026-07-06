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

## Backups (important if tagging real merchandise)
- Set an `EXPORT_KEY` environment variable in Render — a long random string only you know. Without it, the export endpoints are disabled.
- Periodically download a backup:
  ```
  https://your-backend.onrender.com/export/products?key=YOUR_EXPORT_KEY&format=json
  ```
  Save the file somewhere outside of Render/Supabase entirely (cloud drive, external storage).
- **Never rotate `PRIVATE_KEY`/`PUBLIC_KEY` after tagging real merchandise** — doing so permanently invalidates every QR code already printed. Back up both `.pem` files somewhere secure and durable (password manager, encrypted drive) and treat them as permanent for this product line.
- On Supabase, the free tier has no automatic backups and pauses projects after 7 days of inactivity — upgrade to Pro before relying on this for real inventory.
