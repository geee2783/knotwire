/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertTenant,
  createTenantContext,
  issueToken,
  verifyToken,
  buildEvent,
  TenantIsolationError,
} from "./index.js";

test("tenant context requires tenantId and userId", () => {
  assert.throws(() => createTenantContext({ tenantId: "", userId: "u" }));
  assert.throws(() => createTenantContext({ tenantId: "t", userId: "" }));
  const ctx = createTenantContext({ tenantId: "t", userId: "u" });
  assert.equal(ctx.role, "agent");
});

test("assertTenant blocks cross-tenant access", () => {
  const ctx = createTenantContext({ tenantId: "t1", userId: "u" });
  assertTenant(ctx, "t1");
  assert.throws(() => assertTenant(ctx, "t2"), TenantIsolationError);
});

test("jwt issue/verify roundtrip and tamper rejection", () => {
  const token = issueToken({ sub: "u1", tenantId: "t1", role: "admin" }, "secret-123", 60);
  const claims = verifyToken(token, "secret-123");
  assert.equal(claims.sub, "u1");
  assert.equal(claims.tenantId, "t1");
  assert.equal(claims.role, "admin");

  const tampered = `${token.slice(0, -3)}abc`;
  assert.throws(() => verifyToken(tampered, "secret-123"));
  assert.throws(() => verifyToken(token, "wrong-secret"));
});

test("jwt expiry enforced", () => {
  const token = issueToken({ sub: "u", tenantId: "t", role: "agent" }, "secret-123", -1);
  assert.throws(() => verifyToken(token, "secret-123"), /expired/);
});

test("buildEvent fills id/ts and omits absent optionals", () => {
  const ev = buildEvent({
    tenantId: "t",
    actorKind: "user",
    actorId: "u",
    type: "lead.created",
    entity: "lead",
  });
  assert.ok(ev.id.length > 10);
  assert.ok(ev.ts.endsWith("Z"));
  assert.equal("entityId" in ev, false);
  assert.equal("before" in ev, false);
});
