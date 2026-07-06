-- ===================================
-- Migration: multi-tenant accounts, usage quotas, location tracking
-- Run this ONCE in Supabase SQL Editor
-- ===================================

-- 1. ACCOUNTS TABLE — one row per paying customer
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  api_key VARCHAR(64) UNIQUE NOT NULL,
  business_name VARCHAR(255),
  brand_logo_url TEXT,
  brand_color VARCHAR(20) DEFAULT '#c9a227',
  plan VARCHAR(20) NOT NULL DEFAULT 'starter',
  plan_product_limit INT NOT NULL DEFAULT 50,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(30) NOT NULL DEFAULT 'trialing',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_api_key ON accounts(api_key);
CREATE INDEX IF NOT EXISTS idx_accounts_stripe_customer ON accounts(stripe_customer_id);

-- 2. SCOPE EXISTING TABLES TO ACCOUNTS
ALTER TABLE products ADD COLUMN IF NOT EXISTS account_id INT REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS account_id INT REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS account_id INT REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_account_id ON products(account_id);
CREATE INDEX IF NOT EXISTS idx_verifications_account_id ON verifications(account_id);

-- 3. MIGRATE EXISTING DATA INTO A "LEGACY" ACCOUNT
-- This preserves any products/verifications created before multi-tenancy existed
-- (your own testing data, e.g. TEST-001) so nothing is lost.
INSERT INTO accounts (email, password_hash, api_key, business_name, plan, plan_product_limit, subscription_status, is_active)
VALUES ('legacy@internal', 'not-a-real-login', 'legacy-migration-key-not-usable', 'Legacy Data', 'business', 999999, 'active', true)
ON CONFLICT (email) DO NOTHING;

UPDATE products SET account_id = (SELECT id FROM accounts WHERE email = 'legacy@internal') WHERE account_id IS NULL;
UPDATE verifications SET account_id = (SELECT id FROM accounts WHERE email = 'legacy@internal') WHERE account_id IS NULL;

-- 4. CRITICAL FIX: product_id must be unique PER ACCOUNT, not globally.
-- Without this, two different customers both naming a product "SKU-001" would collide.
-- The old verifications->products foreign key depends on the old unique constraint,
-- so it has to be dropped first.
ALTER TABLE verifications DROP CONSTRAINT IF EXISTS verifications_product_id_fkey;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_id_key;
ALTER TABLE products ADD CONSTRAINT products_account_product_unique UNIQUE (account_id, product_id);

-- 5. VERIFY
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'accounts' ORDER BY ordinal_position;
SELECT column_name FROM information_schema.columns WHERE table_name = 'products' AND column_name = 'account_id';
SELECT column_name FROM information_schema.columns WHERE table_name = 'verifications' AND column_name IN ('account_id', 'location_country', 'location_city');
SELECT conname FROM pg_constraint WHERE conname = 'products_account_product_unique';
