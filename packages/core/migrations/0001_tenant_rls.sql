-- Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
-- M0 tenant isolation kit: PostgreSQL row-level security for shared-schema tenancy.
-- Applied by migration runner; `SET LOCAL app.tenant_id = '<uuid>'` must wrap every request.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  pipeline_id          uuid,
  stage_id             uuid,
  name                 text NOT NULL,
  price                numeric,
  responsible_user_id  uuid,
  source_id            uuid,
  custom_fields        jsonb NOT NULL DEFAULT '{}',
  tags                 text[] NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_tenant_idx ON leads (tenant_id);
CREATE INDEX IF NOT EXISTS leads_tenant_stage_idx ON leads (tenant_id, stage_id);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON leads;
CREATE POLICY tenant_isolation ON leads
  USING (tenant_id::text = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.tenant_id', true));
