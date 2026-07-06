-- ===================================
-- Anti-Counterfeit QR System Database Setup
-- Run this in PgAdmin4 Query Tool
-- ===================================

-- ===================================
-- 1. PRODUCTS TABLE
-- Stores all products with QR codes
-- ===================================
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  product_id VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  batch VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_by VARCHAR(100),
  qr_data_url TEXT,
  signed_token TEXT,
  inscription_id VARCHAR(200)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_products_product_id ON products(product_id);
CREATE INDEX IF NOT EXISTS idx_products_is_active ON products(is_active);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at);

-- ===================================
-- 2. VERIFICATIONS TABLE
-- Tracks every scan/verification attempt
-- ===================================
CREATE TABLE IF NOT EXISTS verifications (
  id SERIAL PRIMARY KEY,
  product_id VARCHAR(255) NOT NULL,
  verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_valid BOOLEAN NOT NULL,
  risk_level VARCHAR(20),
  ip_address VARCHAR(45),
  user_agent TEXT,
  location_country VARCHAR(100),
  location_city VARCHAR(100),
  error_message TEXT,
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_verifications_product_id ON verifications(product_id);
CREATE INDEX IF NOT EXISTS idx_verifications_verified_at ON verifications(verified_at);
CREATE INDEX IF NOT EXISTS idx_verifications_risk_level ON verifications(risk_level);
CREATE INDEX IF NOT EXISTS idx_verifications_is_valid ON verifications(is_valid);

-- ===================================
-- 3. ADMIN USERS TABLE (Optional)
-- For future multi-admin support
-- ===================================
CREATE TABLE IF NOT EXISTS admin_users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP,
  is_active BOOLEAN DEFAULT true
);

-- ===================================
-- 4. AUDIT LOG TABLE (Optional)
-- Track all admin actions
-- ===================================
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  admin_username VARCHAR(100),
  action VARCHAR(100) NOT NULL,
  details TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- ===================================
-- 5. USEFUL VIEWS FOR ANALYTICS
-- ===================================

-- View: Product verification counts
CREATE OR REPLACE VIEW product_stats AS
SELECT 
  p.product_id,
  p.name,
  p.batch,
  p.is_active,
  p.created_at,
  COUNT(v.id) as total_verifications,
  COUNT(CASE WHEN v.is_valid = true THEN 1 END) as valid_verifications,
  COUNT(CASE WHEN v.risk_level = 'high' THEN 1 END) as high_risk_count,
  MAX(v.verified_at) as last_verified_at
FROM products p
LEFT JOIN verifications v ON p.product_id = v.product_id
GROUP BY p.id, p.product_id, p.name, p.batch, p.is_active, p.created_at;

-- View: Recent suspicious activity
CREATE OR REPLACE VIEW suspicious_activity AS
SELECT 
  v.id,
  v.product_id,
  p.name as product_name,
  v.verified_at,
  v.risk_level,
  v.ip_address,
  v.location_country,
  v.location_city
FROM verifications v
JOIN products p ON v.product_id = p.product_id
WHERE v.risk_level IN ('medium', 'high')
ORDER BY v.verified_at DESC;

-- View: Daily verification statistics
CREATE OR REPLACE VIEW daily_stats AS
SELECT 
  DATE(verified_at) as date,
  COUNT(*) as total_verifications,
  COUNT(DISTINCT product_id) as unique_products,
  COUNT(CASE WHEN risk_level = 'low' THEN 1 END) as low_risk,
  COUNT(CASE WHEN risk_level = 'medium' THEN 1 END) as medium_risk,
  COUNT(CASE WHEN risk_level = 'high' THEN 1 END) as high_risk
FROM verifications
GROUP BY DATE(verified_at)
ORDER BY date DESC;

-- ===================================
-- 6. SAMPLE DATA (Optional - for testing)
-- ===================================

-- Uncomment to insert test data
/*
INSERT INTO products (product_id, name, batch, notes) VALUES
  ('TEST-001', 'Sample Widget Pro', 'BATCH-2025-01', 'Test product'),
  ('TEST-002', 'Sample Gadget Max', 'BATCH-2025-01', 'Test product');

INSERT INTO verifications (product_id, is_valid, risk_level, ip_address) VALUES
  ('TEST-001', true, 'low', '192.168.1.1'),
  ('TEST-001', true, 'medium', '192.168.1.1'),
  ('TEST-002', true, 'low', '203.0.113.5');
*/

-- ===================================
-- 7. VERIFICATION
-- ===================================

-- Check if tables were created
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- Check if views were created
SELECT table_name 
FROM information_schema.views 
WHERE table_schema = 'public'
ORDER BY table_name;

-- ===================================
-- DONE! Tables are ready to use.
-- ===================================

-- Next steps:
-- 1. Run this entire script in PgAdmin4
-- 2. Deploy updated backend code to Render
-- 3. Test by generating a QR code
-- 4. Check that data appears in the tables
