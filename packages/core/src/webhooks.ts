/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * Outbound webhook delivery with at-least-once semantics: enqueue on write,
 * deliver with exponential backoff, HMAC-SHA256 signature header
 * `x-knotwire-signature: sha256=<hex>`.
 *
 * All delivery reads/writes run inside per-tenant transactions (`withTenant`),
 * so Force-RLS isolation is preserved. The worker discovers tenant ids from
 * the (non-RLS) tenants table and visits each in turn.
 */

import { createHmac } from "node:crypto";
import type pg from "pg";
import { withTenant } from "./db.js";

const MAX_DELIVERY_ATTEMPTS = 5;

export function signPayload(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export async function enqueueWebhooks(
  pool: pg.Pool,
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      "SELECT id, url, secret FROM webhooks WHERE active = true AND $1 = ANY(events)",
      [eventType],
    );
    for (const hook of rows) {
      await client.query(
        "INSERT INTO webhook_deliveries (tenant_id, webhook_id, body) VALUES ($1, $2, $3)",
        [
          tenantId,
          hook.id,
          JSON.stringify({ event: eventType, sent_at: new Date().toISOString(), data: payload }),
        ],
      );
    }
    return rows.length;
  });
}

export interface DeliveryReport {
  delivered: number;
  retried: number;
  exhausted: number;
}

async function deliverTenantDue(client: pg.PoolClient, limit: number): Promise<DeliveryReport> {
  const { rows } = await client.query(
    `SELECT d.id, d.webhook_id, d.body, d.attempts, w.url, w.secret
     FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= now()
     ORDER BY d.created_at
     LIMIT $1`,
    [limit],
  );
  const report: DeliveryReport = { delivered: 0, retried: 0, exhausted: 0 };
  for (const row of rows) {
    const body = JSON.stringify(row.body);
    const signature = signPayload(row.secret, body);
    let ok = false;
    let error: string | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(row.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "knotwire-webhooks/1",
          "x-knotwire-signature": signature,
          "x-knotwire-delivery": String(row.id),
        },
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      clearTimeout(timer);
      ok = res.status >= 200 && res.status < 300;
      if (!ok) error = `http_${res.status}`;
    } catch (err) {
      error = (err as Error).message.slice(0, 200);
    }
    if (ok) {
      await client.query(
        "UPDATE webhook_deliveries SET status='delivered', delivered_at=now(), attempts=attempts+1 WHERE id=$1",
        [row.id],
      );
      report.delivered += 1;
      continue;
    }
    const attempts = row.attempts + 1;
    const exhausted = attempts >= MAX_DELIVERY_ATTEMPTS;
    const backoffSeconds = Math.min(21600, 30 * 2 ** attempts);
    await client.query(
      `UPDATE webhook_deliveries
       SET attempts=$2, status=$3, last_error=$4, next_attempt_at=now() + ($5 || ' seconds')::interval
       WHERE id=$1`,
      [row.id, attempts, exhausted ? "exhausted" : "pending", error, String(backoffSeconds)],
    );
    if (exhausted) report.exhausted += 1;
    else report.retried += 1;
  }
  return report;
}

/** Attempt delivery of due webhook deliveries, tenant by tenant. Call periodically (e.g. every 5 s). */
export async function deliverDue(pool: pg.Pool, limitPerTenant = 25): Promise<DeliveryReport> {
  const tenants = await pool.query("SELECT id FROM tenants");
  const total: DeliveryReport = { delivered: 0, retried: 0, exhausted: 0 };
  for (const { id: tenantId } of tenants.rows) {
    try {
      const report = await withTenant(pool, tenantId, async (client) => deliverTenantDue(client, limitPerTenant));
      total.delivered += report.delivered;
      total.retried += report.retried;
      total.exhausted += report.exhausted;
    } catch {
      // one tenant's failure must not block the rest; error state is recorded per delivery
    }
  }
  return total;
}
