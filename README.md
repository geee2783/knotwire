# Knotwire

Knotwire is a self-hosted, open-source CRM for messaging-first sales teams:
pipelines & leads, a unified WhatsApp / Messenger inbox, a deterministic dialog
engine, an AI agent with pluggable models, and a fully documented public API —
all on your infrastructure, with your data.

**Status: v1.0.0 — first stable ("First to production"). See RELEASE-v1.md.**
Previous milestones: M0 foundations, M1 core CRM, M2 WhatsApp inbox, M3 Facebook
pipeline, M4 dialog engine, M5 AI agent, M6 hardening + Tailscale.

## Principles

- Self-hostable from day 1. Single-tenant deployment; no forced cloud.
- AGPL-3.0-only. No proprietary code reuse; independent implementation.
- API-first: every feature is reachable through the documented REST API.
- Open data: export leads, inbox, and catalog at any time.

## License

AGPL-3.0-only. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
"Knotwire" is a working title and is not a registered trademark; see
[TRADEMARK.md](./TRADEMARK.md).

## M0 quickstart

```bash
npm install
npm test
docker compose up postgres redis   # optional infra
npm run dev                        # http://localhost:8080/healthz
```

## Repository layout

```
packages/core/   Tenancy, auth (JWT), domain events, RLS migration kit
apps/api/        HTTP server (health/readiness; grows with milestones)
charts/knotwire/ Helm chart (skeleton)
docs/            ADRs, self-host guide, threat model
```

## Roadmap

See `plans/kommo-oss-plan.md` in the parent workspace: M1 core CRM →
M2 WhatsApp inbox → M3 Facebook pipeline → M4 dialog engine → M5 AI agent →
M6 public API + Tailscale → v1 GA.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). By submitting a contribution you agree
to the AGPL-3.0 license and the DCO (`Signed-off-by`).
