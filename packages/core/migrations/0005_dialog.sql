-- Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
-- M4 schema: dialog engine (bots, sessions, triggers, run log).

CREATE TABLE IF NOT EXISTS bots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'draft',   -- draft | published
  version               int NOT NULL DEFAULT 1,
  steps                 jsonb NOT NULL DEFAULT '[]',     -- original step schema (typed tuples)
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, version)
);
CREATE INDEX IF NOT EXISTS bots_tenant_idx ON bots (tenant_id);

CREATE TABLE IF NOT EXISTS bot_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  bot_id          uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  current_step    int NOT NULL DEFAULT 0,
  waiting_step    int,
  variables       jsonb NOT NULL DEFAULT '{}',
  state           text NOT NULL DEFAULT 'active',        -- active | finished | failed
  last_reply      text,
  last_step_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_sessions_active_idx ON bot_sessions (tenant_id, state) WHERE state='active';
CREATE INDEX IF NOT EXISTS bot_sessions_conversation_idx ON bot_sessions (conversation_id);

CREATE TABLE IF NOT EXISTS bot_triggers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  bot_id          uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  kind            text NOT NULL,                         -- message_received | lead_created | stage_changed | manual
  filter          jsonb NOT NULL DEFAULT '{}',           -- e.g. {pipeline_id, stage_id, tag, channel}
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_triggers_tenant_idx ON bot_triggers (tenant_id, kind) WHERE active=true;

CREATE TABLE IF NOT EXISTS bot_runs (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  session_id      uuid NOT NULL REFERENCES bot_sessions(id) ON DELETE CASCADE,
  step_index      int NOT NULL,
  step_type       text NOT NULL,
  transcript      jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_runs_session_idx ON bot_runs (session_id, created_at);

DO $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON bots');
  EXECUTE 'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
  EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON bot_sessions');
  EXECUTE 'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON bot_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bots','bot_sessions','bot_triggers','bot_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;
