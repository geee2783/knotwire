-- Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
-- M6 schema: API keys (SHA-256 hashed) + key audit.

CREATE TABLE IF NOT EXISTS api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  label       text NOT NULL,
  key_hash    text NOT NULL UNIQUE,          -- sha256 hex of the plaintext key
  prefix      text NOT NULL,                 -- e.g. "knot_live_…" (display only)
  role        text NOT NULL DEFAULT 'agent',
  scopes      jsonb NOT NULL DEFAULT '[]',   -- reserved; empty = unrestricted for now
  active      boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys (tenant_id);

DO $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON api_keys');
  EXECUTE 'CREATE TRIGGER trg_updated_at BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at()';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;
