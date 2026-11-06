/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createApi } from "./server.js";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { server } = createApi({ databaseUrl: null, jwtSecret: "test-secret", startWebhookWorker: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test("GET /healthz returns ok with version", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; version: string };
    assert.equal(body.status, "ok");
    assert.equal(body.version, "1.0.0");
  });
});

test("GET /readyz returns 503 when DATABASE_URL is not configured", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 503);
  });
});

test("unknown path returns 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/definitely-not-a-route`);
    assert.equal(res.status, 404);
  });
});

test("/api/v1 routes require a bearer token", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/leads`);
    assert.equal(res.status, 401);
  });
});

test("openapi document is served publicly", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/v1/openapi.json`);
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { openapi: string };
    assert.equal(doc.openapi, "3.1.0");
  });
});
