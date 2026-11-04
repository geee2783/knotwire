/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { createApi } from "./server.js";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = createApi();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test("GET /healthz returns ok", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "ok");
  });
});

test("GET /readyz returns ready", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/readyz`);
    assert.equal(res.status, 200);
  });
});

test("unknown path returns 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/definitely-not-a-route`);
    assert.equal(res.status, 404);
  });
});
