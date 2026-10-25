-- ============================================================
-- WACRM Neon PostgreSQL Consolidated Schema
-- Insurance WhatsApp Inbox Edition
--
-- Single-run schema for a blank Neon PostgreSQL database.
-- - All user_id references use TEXT for Clerk user IDs (e.g. 'user_2...').
-- - Multi-tenant account isolation via account_id.
-- - No Supabase-specific dependencies or auth.users references.
-- - Essential core: accounts, profiles, contacts, tags, custom fields,
--   conversations, messages (with Backblaze B2 media), templates,
--   quick replies, visual flows, API keys, webhooks, and notifications.
-- ============================================================

-- Enable required standard PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Compatibility shim for auth.uid() when running with Clerk authentication
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS TEXT AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '');
$$ LANGUAGE sql STABLE;

-- Enum Types
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_role_enum') THEN
    CREATE TYPE account_role_enum AS ENUM ('owner', 'admin', 'agent', 'viewer');
  END IF;
END $$;

-- Generic update timestamp trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 1. ACCOUNTS & PROFILES (Clerk Authenticated)
-- ============================================================

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL, -- Clerk user_id
  default_currency TEXT DEFAULT 'INR',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_one_per_owner
  ON accounts(owner_user_id);

CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE, -- Clerk user_id (e.g. 'user_2...')
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  account_role account_role_enum NOT NULL DEFAULT 'owner',
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT DEFAULT 'user',
  beta_features TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_account_role
  ON profiles(account_id, account_role);

-- Membership helper
CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
        WHEN 'owner' THEN true
        WHEN 'admin' THEN min_role IN ('admin', 'agent', 'viewer')
        WHEN 'agent' THEN min_role IN ('agent', 'viewer')
        WHEN 'viewer' THEN min_role = 'viewer'
        ELSE false
      END
  );
$$;

-- ============================================================
-- 2. CONTACTS, TAGS & CUSTOM FIELDS
-- ============================================================

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT, -- assigned agent user_id
  phone TEXT NOT NULL,
  name TEXT,
  email TEXT,
  company TEXT,
  avatar_url TEXT,
  business_scoped_user_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_contacts_account_id ON contacts(account_id);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);

CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, name)
);

CREATE INDEX IF NOT EXISTS idx_tags_account_id ON tags(account_id);

CREATE TABLE IF NOT EXISTS contact_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_tags_contact ON contact_tags(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id);

CREATE TABLE IF NOT EXISTS custom_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT,
  field_name TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  field_options JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_custom_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  custom_field_id UUID NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, custom_field_id)
);

CREATE TABLE IF NOT EXISTS contact_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id TEXT,
  note_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 3. CONVERSATIONS & MESSAGES (Backblaze B2 Media Integration)
-- ============================================================

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  user_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  assigned_agent_id TEXT,
  last_message_text TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count INTEGER DEFAULT 0,
  first_inbound_at TIMESTAMPTZ,
  last_inbound_at TIMESTAMPTZ,
  last_reply_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_account_id ON conversations(account_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact_id ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent', 'bot')),
  sender_id TEXT,
  content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive')),
  content_text TEXT,
  media_url TEXT,
  media_type TEXT,
  media_key TEXT,                    -- Backblaze B2 object key (e.g. whatsapp-media/<ref>/<file>)
  media_mime_type TEXT,              -- MIME type of the stored media
  media_size BIGINT,                 -- File size in bytes
  media_filename TEXT,               -- Original filename from sender (if available)
  media_status TEXT DEFAULT NULL CHECK (media_status IS NULL OR media_status IN ('pending', 'uploaded', 'failed')),
  template_name TEXT,
  message_id TEXT, -- Meta WAMID
  reply_to_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  interactive_reply_id TEXT,
  interactive_payload JSONB,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed')),
  failure_reason TEXT,
  interactive_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_message_id ON messages (conversation_id, message_id);
CREATE INDEX IF NOT EXISTS idx_messages_media_status ON messages(media_status) WHERE media_status IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('customer', 'agent')),
  sender_id TEXT,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS pending_message_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  error_code TEXT,
  error_title TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_statuses_message_id ON pending_message_statuses(message_id);

-- ============================================================
-- 4. WHATSAPP CONFIG, TEMPLATES & QUICK REPLIES
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number_id TEXT NOT NULL,
  waba_id TEXT,
  access_token TEXT NOT NULL,
  verify_token TEXT,
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected')),
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id)
);

CREATE TABLE IF NOT EXISTS message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'UTILITY' CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION', 'Utility', 'Marketing', 'Authentication')),
  language TEXT DEFAULT 'en_US',
  header_type TEXT CHECK (header_type IN ('text', 'image', 'video', 'document')),
  header_content TEXT,
  body_text TEXT NOT NULL,
  footer_text TEXT,
  buttons JSONB,
  status TEXT DEFAULT 'APPROVED' CHECK (status IN ('Draft', 'Pending', 'Approved', 'Rejected', 'APPROVED', 'PENDING', 'REJECTED')),
  meta_template_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, name, language)
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id, shortcut)
);

-- ============================================================
-- 5. FLOW ENGINE (Visual Workflows)
-- ============================================================

CREATE TABLE IF NOT EXISTS flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
  trigger_config JSONB DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT false,
  runs_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flows_account_id ON flows(account_id);

CREATE TABLE IF NOT EXISTS flow_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_key TEXT,
  node_type TEXT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  position_x NUMERIC DEFAULT 0,
  position_y NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_nodes_flow_id ON flow_nodes(flow_id);

CREATE TABLE IF NOT EXISTS flow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'completed', 'handed_off', 'timed_out',
    'paused_by_agent', 'cancelled', 'failed'
  )),
  current_node_id UUID REFERENCES flow_nodes(id) ON DELETE SET NULL,
  variables JSONB NOT NULL DEFAULT '{}'::jsonb,
  transition_seq INTEGER NOT NULL DEFAULT 0,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  resume_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_runs_account_status ON flow_runs(account_id, status);
CREATE INDEX IF NOT EXISTS idx_flow_runs_contact_status ON flow_runs(contact_id, status);

CREATE TABLE IF NOT EXISTS flow_run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  node_id UUID REFERENCES flow_nodes(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 6. API KEYS, WEBHOOKS & NOTIFICATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY['messages:send'],
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT ARRAY['*'],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id TEXT,
  title TEXT NOT NULL,
  content TEXT,
  type TEXT NOT NULL DEFAULT 'info',
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 7. ESSENTIAL STORED PROCEDURES & RPCs
-- ============================================================

-- Atomic bump conversation on inbound message
CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count      = COALESCE(unread_count, 0) + 1,
      last_message_text = p_last_message_text,
      last_message_at   = NOW(),
      updated_at        = NOW()
  WHERE id = p_conversation_id;
$$;

-- Atomic increment flow execution count
CREATE OR REPLACE FUNCTION public.increment_flow_execution_count(
  p_flow_id UUID
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE flows
  SET runs_count = runs_count + 1,
      updated_at = NOW()
  WHERE id = p_flow_id;
$$;

-- Server-side contact tag filter with windowed total count
CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS full_count
    FROM matched
    ORDER BY created_at DESC
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, p.full_count AS total_count
  FROM page p
  JOIN contacts c ON c.id = p.id
  ORDER BY c.created_at DESC;
$$;

-- Atomic replace flow nodes
CREATE OR REPLACE FUNCTION public.replace_flow_nodes(
  p_flow_id UUID,
  p_nodes JSONB
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
BEGIN
  IF p_nodes IS NULL OR jsonb_typeof(p_nodes) <> 'array' THEN
    RAISE EXCEPTION 'p_nodes must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT account_id INTO v_account_id
  FROM flows
  WHERE id = p_flow_id
  FOR UPDATE;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Flow not found' USING ERRCODE = '42501';
  END IF;

  DELETE FROM flow_nodes WHERE flow_id = p_flow_id;

  INSERT INTO flow_nodes (flow_id, node_key, node_type, config, position_x, position_y)
  SELECT
    p_flow_id,
    n->>'node_key',
    n->>'node_type',
    COALESCE(n->'config', '{}'::jsonb),
    COALESCE((n->>'position_x')::NUMERIC, 0),
    COALESCE((n->>'position_y')::NUMERIC, 0)
  FROM jsonb_array_elements(p_nodes) AS n;

  UPDATE flow_runs r
  SET status = 'cancelled',
      ended_at = NOW(),
      end_reason = 'current_node_removed'
  WHERE r.flow_id = p_flow_id
    AND r.status = 'active';

  RETURN jsonb_array_length(p_nodes);
END;
$$;
