# Security Policy

## Reporting a vulnerability

Do **not** open a public issue, PR, or discussion for security defects.

Email: security@knotwire.dev (placeholder until GA launch — may change).
We aim to acknowledge within 72 hours and provide a fix timeline within
10 business days.

## Scope

- Tenant isolation (row-level security, shared-schema tenancy)
- Credential storage (KMS-wrapped secrets, channel tokens)
- Outbound webhook delivery (SSRF surface)
- Inbound AI agent prompt injection and tool authorization
- WhatsApp/Facebook token handling and 24h window compliance

## Out of scope (M0)

- Issues in unmerged upstream dependencies; please report those upstream.
- Social engineering, spam, or denial of service without a concrete impact.
