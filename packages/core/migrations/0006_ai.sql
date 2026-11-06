-- Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
-- M5 schema: AI agents, knowledge sources, sessions, usage log.

CREATE TABLE IF NOT EXISTS ai_agents (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'draft',   -- draft | published
  provider              text NOT NULL DEFAULT 'fake',    -- fake | openai | anthropic
  model                 text,
  api_key_enc           text,                            -- AES-256-GCM ("v1:.."); null = no key
  system_prompt         text NOT NULL DEFAULT '',
  tools                 jsonb NOT NULL DEFAULT '["lookup_product","update_lead","move_stage","create_task","hand_off"]',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_agents_tenant_idx ON ai_agents (tenant_id);

CREATE TABLE IF NOT EXISTS ai_sources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  kind            text NOT NULL,                          -- text | url | file
  title           text NOT NULL,
  content         text NOT NULL DEFAULT '',               -- fetched/indexed text (url/file resolved at ingest)
  source_url      text,
  embedding       real[],                                 -- reserved for pgvector upgrade; unused in fake mode
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_sources_tenant_idx ON ai_sources (tenant_id);

CREATE TABLE IF NOT EXISTS ai_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  agent_id        uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  state           text NOT NULL DEFAULT 'active',          -- active | handed_off | finished
  history         jsonb NOT NULL DEFAULT '[]',             -- [{role, text, ts}]
  turn_count      int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_sessions_conversation_idx ON ai_sessions (conversation_id, state);

CREATE TABLE IF NOT EXISTS ai_usage (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  agent_id        uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  prompt_tokens   int NOT NULL DEFAULT 0,
  completion_tokens int NOT NULL DEFAULT 0,
  cost_usd        numeric NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_tenant_idx ON ai_usage (tenant_id, created_at);

DO $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON ai_agents');
  EXECUTE 'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON ai_agents FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON ai_sources');
  EXECUTE 'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON ai_sources FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON ai_sessions');
  EXECUTE 'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON ai_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_agents','ai_sources','ai_sessions','ai_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;
