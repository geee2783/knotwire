# Knotwire v1.0.0 — "First to production"

First stable release of Knotwire: an original, self-hosted, AGPL-3.0 open-source
CRM for messaging-first sales teams. No code, assets, or copy from any
proprietary vendor (Kommo/amoCRM or otherwise) — feature parity was achieved
through independent implementation guided by publicly documented behavior.

## What's in v1

- **Core CRM** — pipelines/stages, leads (+ incoming-leads accept/decline triage),
  contacts, companies, tasks, notes, tags, custom fields, loss reasons, audit log
- **Tenancy** — shared-schema multi-tenancy with PostgreSQL FORCE RLS from day one;
  least-privilege `knotwire_app` role; per-tenant audit trails
- **WhatsApp inbox** — unified conversations, team assignment, internal notes,
  24h service-window enforcement, approved-template sends after window close,
  opt-out registry; encrypted wa_id storage
- **Facebook pipeline** — Messenger channel, lead-form → incoming-leads ingestion,
  m.me referral attribution (`mk_` marketplace, `ad_` campaign) with per-ref stats
- **Dialog engine** — deterministic bot runtime (original schema: say/buttons/ask/
  actions/conditions/validate/find/goto…), published versioning, sessions,
  triggers (message/lead/stage), simulate endpoint
- **AI agent** — model-agnostic (fake provider ships; OpenAI/Anthropic join with
  your key), KB keyword retrieval, handoff, usage + cost log; Copilot endpoints
- **Public API** — REST `/api/v1`, OpenAPI 3.1, Bearer JWT + `X-Api-Key` auth,
  API-key management with revocation, per-tenant rate limiting (429 + Retry-After),
  outbound webhooks (HMAC-SHA256, exponential backoff, at-least-once), CSV import/export
- **Operations** — JSON request logs, `/healthz` + `/readyz`, security headers
  (nosniff, DENY, no-referrer), Docker Compose + Helm, **Tailscale profile**
  (private tailnet access, zero inbound ports; FMunnel opt-in)

## Known credential-gated items (documented, several in code)
Real Meta (WABA/Graph) wiring, Meta App Review, real LLM provider adapters,
embeddings/pgvector retrieval, file ingestion, visual dialog editor, wait-step
timers, multi-instance rate limiting (swap to Redis). All provider boundaries
and client interfaces are already shaped; no architecture change needed.

## Self-host
```bash
SUPERUSER_DATABASE_URL=postgres://.../knotwire APP_ROLE_PASSWORD=... npm run db:setup
DATABASE_URL=postgres://knotwire_app:.../knotwire \
KNOTWIRE_JWT_SECRET=... KNOTWIRE_MASTER_KEY=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))') \
npm run dev
```

## Security
Report vulnerabilities via SECURITY.md. This release is a feature-complete
first stable; a professional security audit is recommended before hosting
untrusted multi-tenant workloads.
