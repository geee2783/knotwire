# ADR 0001 — Modular monolith + PostgreSQL RLS for tenant isolation

**Status:** accepted (Nov 2026)

## Context
Knotwire is self-hosted and single-node friendly. A microservice-first design
would impose operational complexity before product-market fit. Tenants share
one schema; isolation must be enforced by the database, not by application
convention.

## Decision
- One modular monolith (Node 26, TypeScript, npm workspaces).
- Shared-schema multi-tenancy enforced by **PostgreSQL row-level security**
  with `SET LOCAL app.tenant_id` on every transaction (M0 migration
  `packages/core/migrations/0001_tenant_rls.sql`).
- Redis for queues/locks; NATS JetStream deferred until event volume justifies
  it (decision point: end of M2).
- S3-compatible object storage for attachments; no proprietary storage APIs.

## Rejected alternatives
- Schema-per-tenant: stronger isolation but complicates migrations and
  backups at scale — revisit for enterprise tier post-v1.
- Building microservices first: premature; violates single-tenant self-host
  simplicity.

## Consequences
- Every new entity table requires: tenant_id column, RLS policy, index on
  (tenant_id[, stage_id]). Migration CI job enforces.
- Application-level `assertTenant()` double-checks are defense-in-depth, never
  the primary control.
