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

Migrations (run once, as superuser; the app role is least-privilege):
```bash
SUPERUSER_DATABASE_URL='postgres://postgres:pw@127.0.0.1:5432/knotwire' APP_ROLE_PASSWORD='<app-role-pw>' npm run db:setup
```
This creates the `knotwire_app` role (RLS enforced), grants, and applies
`packages/core/migrations/` in order. The API boots with `DATABASE_URL`
pointing at the app role and does **not** attempt migrations at startup
(set `KNOTWIRE_APPLY_MIGRATIONS=true` only for single-user dev environments).

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
