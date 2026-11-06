-- Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
-- M6 addition: SECURITY DEFINER lookup for API-key validation.
-- RLS would otherwise hide the row (the tenant is unknown until the key is
-- validated). The function returns only id/tenant_id/role for an active key.

CREATE OR REPLACE FUNCTION lookup_api_key(p_key_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, role text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT k.id, k.tenant_id, k.role
  FROM api_keys k
  WHERE k.key_hash = p_key_hash AND k.active = true
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION lookup_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lookup_api_key(text) TO knotwire_app;
