-- ===================================
-- Migration: email verification + password reset
-- Run this ONCE in Supabase SQL Editor
-- ===================================

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_token_hash VARCHAR(64);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS verification_expires TIMESTAMP;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(64);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS reset_expires TIMESTAMP;

-- Verify
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'accounts' AND column_name IN
  ('email_verified', 'verification_token_hash', 'verification_expires', 'reset_token_hash', 'reset_expires');
