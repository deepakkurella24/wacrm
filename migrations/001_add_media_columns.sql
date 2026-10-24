-- ============================================================
-- Migration: Add Backblaze B2 media columns to messages table
--
-- Run this on your existing Neon database to add the columns
-- needed for incoming WhatsApp media storage via Backblaze B2.
--
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================

-- Backblaze B2 object key (e.g. whatsapp-media/<ref>/<file>)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_key TEXT;

-- MIME type of the stored media
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime_type TEXT;

-- File size in bytes
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_size BIGINT;

-- Original filename from sender (if available)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_filename TEXT;

-- Upload status: NULL (no media / text-only), 'pending', 'uploaded', 'failed'
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_status TEXT DEFAULT NULL;

-- Index for efficient lookup of messages with media (for retry jobs, etc.)
CREATE INDEX IF NOT EXISTS idx_messages_media_status
  ON messages(media_status) WHERE media_status IS NOT NULL;
