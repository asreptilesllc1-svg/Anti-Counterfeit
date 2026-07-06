-- ===================================
-- Migration: add blockchain inscription tracking
-- Run this ONCE in Supabase SQL Editor
-- ===================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS inscription_id VARCHAR(200);

-- Verify it worked:
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'products'
ORDER BY ordinal_position;
