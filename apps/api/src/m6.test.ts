/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation.
 *
 * M6: hardening (API keys, rate limit, security headers, request logging).
 * Requires DATABASE_URL (knotwire_app) and migrations 0001-0007.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { connect, issueToken } from "@knotwire/core";
import { createApi } from "./server.js";
import { RateLimiter } from "./safety.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const SECRET = "test-secret";
const HIGH_LIMIT = "100000";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { server, pool } = createApi({ databaseUrl: DATABASE_URL, jwtSecret: SECRET, startWebhookWorker: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await pool?.end();
  }
}

async function seedTenant(name: string): Promise<string> {
  const pool = connect(DATABASE_URL!);
  try {
    const r = await pool.query(
      "INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id",
      [name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`],
    );
    return r.rows[0].id as string;
  } finally {
    await pool.end();
  }
}

const bearer = (tenantId: string, role: string) =>
  ({ authorization: `Bearer ${issueToken({ sub: "11111111-1111-4111-8111-111111111111", tenantId, role }, SECRET, 600)}` });

test("rate limiter token bucket", () => {
  const rl = new RateLimiter(2);
  assert.equal(rl.check("t", 0).allowed, true);
  assert.equal(rl.check("t", 0).allowed, true);
  assert.equal(rl.check("t", 0).allowed, false);
  // refill after 30s at 2/min
  assert.equal(rl.check("t", 30_000).allowed, true);
});

test("m6 integration (api keys, headers, rate limit)", { skip: DATABASE_URL ? false : "DATABASE_URL not set" }, async () => {
  const tenantA = await seedTenant("HardA");
  await withServer(async (base) => {
    const h = bearer(tenantA, "admin");

    // security headers
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-frame-options"), "DENY");

    // issue an API key (manager role issuance requires admin JWT)
    const issued = await fetch(`${base}/api/v1/api-keys`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ label: "test-key", role: "agent" }),
    });
    assert.equal(issued.status, 201);
    const keyBody = (await issued.json()) as { plaintext: string; prefix: string; id: string };
    assert.ok(keyBody.plaintext.startsWith("knot_live_"));

    // key auth works against /leads
    const byKey = await fetch(`${base}/api/v1/leads`, { headers: { "x-api-key": keyBody.plaintext } });
    assert.equal(byKey.status, 200);

    // wrong key rejected
    const wrong = await fetch(`${base}/api/v1/leads`, { headers: { "x-api-key": "knot_live_wrong" } });
    assert.equal(wrong.status, 401);

    // list keys: plaintext never returned
    const listKeys = await fetch(`${base}/api/v1/api-keys`, { headers: h });
    const keysBody = (await listKeys.json()) as { keys: Array<Record<string, unknown>> };
    assert.ok(keysBody.keys.some((k) => k["prefix"] === keyBody.prefix));
    assert.equal(keysBody.keys.some((k) => "plaintext" in k || "key_hash" in k), false);

    // revoke
    const revoked = await fetch(`${base}/api/v1/api-keys/${keyBody.id}`, { method: "DELETE", headers: h });
    assert.equal(revoked.status, 200);
    const afterRevoke = await fetch(`${base}/api/v1/leads`, { headers: { "x-api-key": keyBody.plaintext } });
    assert.equal(afterRevoke.status, 401);

    // rate limiting: tiny limit, then 429
    const limited = new RateLimiter(3);
    const t = Date.now();
    assert.equal(limited.check(tenantA, t).allowed, true);
    assert.equal(limited.check(tenantA, t).allowed, true);
    assert.equal(limited.check(tenantA, t).allowed, true);
    assert.equal(limited.check(tenantA, t).allowed, false);
    // rate limit at the HTTP layer: server built with a tiny per-minute bucket
    const previous = process.env["KNOTWIRE_RATE_LIMIT_PER_MIN"];
    process.env["KNOTWIRE_RATE_LIMIT_PER_MIN"] = "3";
    try {
      const { server: limitedServer, pool: limitedPool } = createApi({ databaseUrl: DATABASE_URL, jwtSecret: SECRET, startWebhookWorker: false });
      await new Promise<void>((resolve) => limitedServer.listen(0, "127.0.0.1", resolve));
      const limitedPort = (limitedServer.address() as AddressInfo).port;
      const limitedBase = `http://127.0.0.1:${limitedPort}`;
      let lastStatus = 0;
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${limitedBase}/api/v1/leads`, { headers: h });
        lastStatus = res.status;
      }
      assert.equal(lastStatus, 429);
      limitedServer.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => limitedServer.close((err) => (err ? reject(err) : resolve())));
      await limitedPool?.end();
    } finally {
      if (previous === undefined) delete process.env["KNOTWIRE_RATE_LIMIT_PER_MIN"];
      else process.env["KNOTWIRE_RATE_LIMIT_PER_MIN"] = previous;
    }
  });
});
