# Contributing to Knotwire

1. All contributions are made under AGPL-3.0-only with a DCO sign-off
   (`git commit -s`). Unsigned contributions cannot be merged.
2. Before submitting: `npm install && npm test && npm run typecheck`.
3. Architecture decisions that affect storage, isolation, or external
   interoperability require an ADR in `docs/adr/` (see `0001` for format).
4. Never submit code, assets, or documentation copied from Kommo/amoCRM or
   other proprietary products. Original, independent implementations only.
5. Security issues: do not open public issues; see [SECURITY.md](./SECURITY.md).
6. Keep PRs scoped to a single milestone workstream (see README roadmap).

## Development

- Node >= 24; npm 11+.
- `npm install` at the repo root (workspaces).
- `npm test` runs all workspace tests (node --test).
- `docker compose up postgres redis` provides PostgreSQL 16 + Redis 7.
