-- Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
-- M1 schema: pipelines, stages, loss reasons, contacts, companies, tasks,
-- notes, audit log, outbound webhooks; tenant RLS on every table.

-- ---------- pipelines & stages ----------
CREATE TABLE IF NOT EXISTS pipelines (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pipelines_tenant_idx ON pipelines (tenant_id);

CREATE TABLE IF NOT EXISTS stages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  pipeline_id uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  color       text NOT NULL DEFAULT '#64748b',
  is_won      boolean NOT NULL DEFAULT false,
  is_lost     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stages_pipeline_idx ON stages (tenant_id, pipeline_id, sort_order);

-- ---------- leads: extend with M1 columns ----------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS incoming   boolean NOT NULL DEFAULT false;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS closed_at  timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS outcome   text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact_id uuid;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_id uuid;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_pipeline_fk') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_pipeline_fk FOREIGN KEY (pipeline_id)
      REFERENCES pipelines(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_stage_fk') THEN
    ALTER TABLE leads ADD CONSTRAINT leads_stage_fk FOREIGN KEY (stage_id)
      REFERENCES stages(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ---------- loss reasons ----------
CREATE TABLE IF NOT EXISTS loss_reasons (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name      text NOT NULL
);
CREATE INDEX IF NOT EXISTS loss_reasons_tenant_idx ON loss_reasons (tenant_id);

-- ---------- contacts & companies ----------
CREATE TABLE IF NOT EXISTS contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                text NOT NULL,
  phone               text,
  email               text,
  custom_fields       jsonb NOT NULL DEFAULT '{}',
  tags                text[] NOT NULL DEFAULT '{}',
  responsible_user_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_tenant_idx ON contacts (tenant_id);
CREATE INDEX IF NOT EXISTS contacts_tenant_email_idx ON contacts (tenant_id, email);

CREATE TABLE IF NOT EXISTS companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                text NOT NULL,
  phone               text,
  email               text,
  website             text,
  custom_fields       jsonb NOT NULL DEFAULT '{}',
  tags                text[] NOT NULL DEFAULT '{}',
  responsible_user_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_tenant_idx ON companies (tenant_id);

-- ---------- tasks & notes ----------
CREATE TABLE IF NOT EXISTS tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  lead_id             uuid REFERENCES leads(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES contacts(id) ON DELETE SET NULL,
  company_id          uuid REFERENCES companies(id) ON DELETE SET NULL,
  title               text NOT NULL,
  due_at              timestamptz,
  responsible_user_id uuid,
  done_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_tenant_idx ON tasks (tenant_id);
CREATE INDEX IF NOT EXISTS tasks_tenant_lead_idx ON tasks (tenant_id, lead_id);

CREATE TABLE IF NOT EXISTS notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  lead_id     uuid REFERENCES leads(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  company_id  uuid REFERENCES companies(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_tenant_idx ON notes (tenant_id);
CREATE INDEX IF NOT EXISTS notes_tenant_lead_idx ON notes (tenant_id, lead_id);

-- ---------- audit log ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  action     text NOT NULL,
  actor_kind text NOT NULL,
  actor_id   text NOT NULL,
  before     jsonb,
  after      jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_idx ON audit_log (tenant_id, created_at);

-- ---------- outbound webhooks ----------
CREATE TABLE IF NOT EXISTS webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  url         text NOT NULL,
  secret      text NOT NULL,            -- HMAC secret; moves to vault ADR in M2
  events      text[] NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_tenant_idx ON webhooks (tenant_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  webhook_id      uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  body            jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pending',
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (tenant_id, status, next_attempt_at);

-- ---------- updated_at trigger ----------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','contacts','companies','tasks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_updated_at ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS for every tenant table ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pipelines','stages','loss_reasons','contacts','companies',
    'tasks','notes','audit_log','webhooks','webhook_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id::text = current_setting(''app.tenant_id'', true)) WITH CHECK (tenant_id::text = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;
