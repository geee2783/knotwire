# Self-host quickstart

## Requirements
- Node >= 24 (build only), or just Docker.
- PostgreSQL 16+ (with RLS; psql for migrations), Redis 7+.

## Option A — Docker Compose (development)
```bash
docker compose up postgres redis -d
npm install && npm test
npm run dev    # http://localhost:8080/healthz
```

Migrations (M0 kit): `psql $DATABASE_URL -f packages/core/migrations/0001_tenant_rls.sql`
(Run per tenant bootstrap in M1; M0 migration is idempotent.)

## Option B — Helm (M0 skeleton)
See `charts/knotwire/templates/NOTES.txt`. Provide Kubernetes Secret
`knotwire-env` with `DATABASE_URL` and `REDIS_URL`. PostgreSQL and Redis are
not deployed by the chart.

## Environment variables
| Var | Default | Purpose |
|---|---|---|
| PORT | 8080 | HTTP port |
| DATABASE_URL | — | Postgres connection string |
| REDIS_URL | — | Redis connection string |

## M6 preview — Tailscale
Self-hosted Knotwire will ship a `tailscale` profile: bind on the tailnet,
optionally exposed via `tailscale serve`, or public HTTPS via `tailscale
funnel` only when the operator opts in. Do not design for inbound public
access before M6 lands.
