-- Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
-- M2 schema: WhatsApp channels, conversations, messages, templates, opt-outs.

-- ---------- whatsapp channel accounts (WABA connection) ----------
CREATE TABLE IF NOT EXISTS channel_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  provider              text NOT NULL DEFAULT 'whatsapp-cloud',
  provider_account_id   text NOT NULL,
  display_name          text,
  access_token_enc      text NOT NULL,                 -- AES-256-GCM "v1:iv:ct:tag"
  verify_token          text NOT NULL,
  phone_number_id       text,
  waba_id               text,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS channel_accounts_tenant_idx ON channel_accounts (tenant_id);

-- ---------- conversations (one per external identity per channel) ----------
CREATE TABLE IF NOT EXISTS conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  channel             text NOT NULL,                    -- e.g. whatsapp-cloud
  channel_account_id  uuid REFERENCES channel_accounts(id) ON DELETE SET NULL,
  external_id_enc     text NOT NULL,                    -- wa_id (encrypted)
  external_id_hash    text NOT NULL,                    -- sha256 hex (lookup)
  display_name        text,
  status              text NOT NULL DEFAULT 'open',     -- open | closed
  assigned_user_id    uuid,
  last_message_at     timestamptz,
  is_closed           boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, external_id_hash)
);
CREATE INDEX IF NOT EXISTS conversations_tenant_idx ON conversations (tenant_id);
CREATE INDEX IF NOT EXISTS conversations_last_message_idx ON conversations (tenant_id, last_message_at DESC);

-- ---------- messages ----------
CREATE TABLE IF NOT EXISTS messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider_message_id text,
  direction           text NOT NULL,                    -- inbound | outbound
  type                text NOT NULL DEFAULT 'text',     -- text | template | image | ...
  body                text,
  delivery_status     text NOT NULL DEFAULT 'sent',     -- sent | delivered | read | failed
  template_name       text,
  is_internal         boolean NOT NULL DEFAULT false,   -- team note (never sent)
  created_by_user_id  uuid,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, sent_at);

-- ---------- whatsapp templates (mirror of Meta-approved templates) ----------
CREATE TABLE IF NOT EXISTS wa_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  name            text NOT NULL,
  language        text NOT NULL DEFAULT 'en',
  category        text NOT NULL DEFAULT 'UTILITY',
  status          text NOT NULL DEFAULT 'PENDING',      -- PENDING | APPROVED | REJECTED
  components      jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, language)
);
CREATE INDEX IF NOT EXISTS wa_templates_tenant_idx ON wa_templates (tenant_id);

-- ---------- opt-out registry (per conversation/channel) ----------
CREATE TABLE IF NOT EXISTS opt_outs (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opt_outs_tenant_idx ON opt_outs (tenant_id);

-- ---------- updated_at trigger ----------
DO $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON conversations');
  EXECUTE 'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
END $$;

-- ---------- RLS ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_accounts','conversations','messages','wa_templates','opt_outs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;
