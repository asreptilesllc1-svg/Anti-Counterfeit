-- ===================================
-- ProductAuth - Fresh Install Schema (multi-tenant)
-- Run this ONCE in a brand new Supabase/Postgres database.
-- If you already have data, use migration-multitenant.sql instead.
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

-- 2. PRODUCTS TABLE — scoped to an account. product_id is only unique WITHIN an account,
-- so two different customers can both have a "SKU-001" without colliding.
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  batch VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  qr_data_url TEXT,
  signed_token TEXT,
  inscription_id VARCHAR(200),
  UNIQUE (account_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_products_account_id ON products(account_id);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at);

-- 3. VERIFICATIONS TABLE — every scan/verification attempt, scoped to an account
CREATE TABLE IF NOT EXISTS verifications (
  id SERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product_id VARCHAR(255) NOT NULL,
  verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_valid BOOLEAN NOT NULL,
  risk_level VARCHAR(20),
  ip_address VARCHAR(45),
  user_agent TEXT,
  location_country VARCHAR(100),
  location_city VARCHAR(100),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_verifications_account_id ON verifications(account_id);
CREATE INDEX IF NOT EXISTS idx_verifications_product_id ON verifications(product_id);
CREATE INDEX IF NOT EXISTS idx_verifications_verified_at ON verifications(verified_at);
CREATE INDEX IF NOT EXISTS idx_verifications_risk_level ON verifications(risk_level);

-- 4. AUDIT LOG — tracks account-level actions
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_account_id ON audit_log(account_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- 5. VERIFY
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
