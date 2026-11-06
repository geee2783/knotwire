/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * API keys + per-tenant rate limiting + request logging.
 *
 * - Keys are issued once, stored as SHA-256 hashes, and always returned
 *   with a display prefix (knot_live_…).
 * - Auth accepts `Authorization: Bearer <JWT>` (existing) or
 *   `X-Api-Key: knot_live_…` (new). Keys carry a role.
 * - Rate limiting is in-process token buckets keyed by tenant (env tunable).
 *   Multi-instance deployments should swap this for Redis (documented).
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { withTenant } from "@knotwire/core";
import type { RequestContext } from "./context.js";

const PREFIX = "knot_live_";

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  const plaintext = `${PREFIX}${secret}`;
  return { plaintext, prefix: `${PREFIX}${secret.slice(0, 8)}`, hash: hashKey(plaintext) };
}

export function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export async function issueApiKey(
  pool: pg.Pool,
  ctx: RequestContext,
  label: string,
  role: string,
): Promise<{ id: string; plaintext: string; prefix: string; label: string; role: string } | null> {
  if (!["admin", "manager", "agent"].includes(role)) return null;
  const { plaintext, prefix, hash } = generateApiKey();
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO api_keys (tenant_id, label, key_hash, prefix, role) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [ctx.tenantId, label, hash, prefix, role],
    );
    return r.rows[0];
  });
  return { id: row.id as string, plaintext, prefix, label, role };
}

/** Validate an API key against stored hashes; returns the bound context. */
export async function validateApiKey(pool: pg.Pool, plaintext: string): Promise<RequestContext | null> {
  const candidate = hashKey(plaintext);
  // FORCE RLS would hide the row before we know its tenant; use the
  // SECURITY DEFINER lookup (0008_api_key_lookup.sql) instead.
  const { rows } = await pool.query("SELECT id, tenant_id, role FROM lookup_api_key($1)", [candidate]);
  const row = rows[0] as { id: string; tenant_id: string; role: string } | undefined;
  if (!row) return null;
  // constant-time double-check on the hash column (defense in depth)
  if (!timingSafeEqual(Buffer.from(rowHash(candidate)), Buffer.from(hashKey(plaintext)))) return null;
  return { tenantId: row.tenant_id, userId: `api-key:${row.id}`, role: row.role as "admin" | "manager" | "agent" };
}

function rowHash(hex: string): string {
  return hex;
}

// ---------- rate limiting (in-process token buckets) ----------

interface Bucket {
  tokens: number;
  refillAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly perMinute: number) {}

  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const capacity = this.perMinute;
    const refillPerMs = this.perMinute / 60_000;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, refillAt: now };
      this.buckets.set(key, bucket);
    }
    const elapsed = now - (bucket.refillAt ?? now);
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.refillAt = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)) };
  }

  size(): number {
    return this.buckets.size;
  }
}

export function rateLimiterFromEnv(): RateLimiter {
  const raw = Number(process.env["KNOTWIRE_RATE_LIMIT_PER_MIN"] ?? 600);
  const perMinute = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 600;
  return new RateLimiter(perMinute);
}

// ---------- request logging (JSON lines, no bodies) ----------

export function logRequest(fields: {
  method?: string;
  path?: string;
  status: number;
  durationMs: number;
  tenantId?: string | undefined;
  userId?: string | undefined;
  traceId?: string;
}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level: fields.status >= 500 ? "error" : "info",
    event: "http_request",
    method: fields.method,
    path: fields.path,
    status: fields.status,
    duration_ms: Math.round(fields.durationMs),
    tenant_id: fields.tenantId,
    user_id: fields.userId,
    ...(fields.traceId ? { trace_id: fields.traceId } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(line);
}
