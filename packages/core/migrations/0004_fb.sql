-- Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
-- M3 schema: attribution columns on conversations/leads (m.me ref, lead forms).

-- ---------- conversation source attribution ----------
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_url text;
CREATE INDEX IF NOT EXISTS conversations_source_ref_idx ON conversations (tenant_id, source_ref);

-- ---------- lead source attribution ----------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_kind text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS source_ref text;
CREATE INDEX IF NOT EXISTS leads_source_ref_idx ON leads (tenant_id, source_ref);
