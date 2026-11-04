# ADR 0002 — AGPL-3.0 + Knotwire brand position

**Status:** accepted (Nov 2026)

## Decision
- License: **AGPL-3.0-only**. Self-host source availability is mandatory.
- Name: **Knotwire** (working title). Not a registered trademark. See
  TRADEMARK.md. No public registration until legal clearance.
- Knotwire contains **zero** code, assets, or text from Kommo/amoCRM or any
  proprietary product. Feature parity = original implementation against a
  publicly documented behavioral contract.
- Contributions require DCO sign-off and AGPL-3.0 acceptance.

## Rationale
Self-hosted AGPL encourages hosting providers to contribute back instead of
strip-mining the project; it is the honest license for an open substitute.

## Compatibility notes
- Keeping AGPL headers in new files is enforced by the `compliance` CI job.
- Third-party deps must be AGPL-compatible (MIT/Apache-2.0/BSD/GPL-family/MPL-2.0
  per GNU compatibility matrix). New dependencies require review in PR.
