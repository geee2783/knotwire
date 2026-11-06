/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * M1 integration tests against a real PostgreSQL (app role, RLS enforced).
 * Requires DATABASE_URL (knotwire_app). Run `npm run db:setup` first (CI does).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";

import { connect, issueToken, withTenant } from "@knotwire/core";
import { createApi } from "./server.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const SECRET = "test-secret";

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

const bearer = (tenantId: string, role: string, userId = "11111111-1111-4111-8111-111111111111") =>
  ({ authorization: `Bearer ${issueToken({ sub: userId, tenantId, role }, SECRET, 600)}` });

test("m1 integration (HTTP + Postgres RLS)", { skip: DATABASE_URL ? false : "DATABASE_URL not set" }, async (t) => {
  const tenantA = await seedTenant("AcmeTest");
  const tenantB = await seedTenant("OtherTest");

  await withServer(async (base) => {
    // pipeline + stages
    const pipelineRes = await fetch(`${base}/api/v1/pipelines`, {
      method: "POST",
      headers: { ...bearer(tenantA, "admin"), "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sales",
        stages: [
          { name: "Incoming Leads", sort_order: 0 },
          { name: "Negotiation", sort_order: 10, color: "#f59e0b" },
          { name: "Won", sort_order: 20, is_won: true },
        ],
      }),
    });
    assert.equal(pipelineRes.status, 201);
    const pipeline = (await pipelineRes.json()) as { id: string; stages: Array<{ id: string; name: string }> };
    assert.ok(pipeline.id);
    assert.equal(pipeline.stages.length, 3);

    // cross-tenant isolation at HTTP layer
    const bList = await fetch(`${base}/api/v1/pipelines`, { headers: bearer(tenantB, "agent") });
    const bBody = (await bList.json()) as { pipelines: Array<{ name: string }> };
    assert.equal(bBody.pipelines.some((p) => p.name === "Sales"), false);

    // incoming lead lifecycle
    const leadRes = await fetch(`${base}/api/v1/incoming-leads`, {
      method: "POST",
      headers: { ...bearer(tenantA, "admin"), "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada Byron", kind: "facebook-lead-ad", price: 4200 }),
    });
    assert.equal(leadRes.status, 201);
    const incoming = (await leadRes.json()) as { id: string; incoming: boolean; tags: string[] };
    assert.equal(incoming.incoming, true);
    assert.ok(incoming.tags.includes("facebook-lead-ad"));

    const acceptRes = await fetch(`${base}/api/v1/incoming-leads/${incoming.id}/accept`, {
      method: "POST",
      headers: bearer(tenantA, "admin"),
    });
    assert.equal(acceptRes.status, 200);
    const accepted = (await acceptRes.json()) as { incoming: boolean; stage_id: string; pipeline_id: string };
    assert.equal(accepted.incoming, false);
    assert.equal(accepted.pipeline_id, pipeline.id);

    // cross-tenant 404 on A's lead
    const cross = await fetch(`${base}/api/v1/leads/${incoming.id}`, { headers: bearer(tenantB, "agent") });
    assert.equal(cross.status, 404);

    // register webhook against a local echo server; verify HMAC signature
    const deliveries: Array<{ body: string; signature: string | undefined }> = [];
    const echo = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        deliveries.push({ body, signature: req.headers["x-knotwire-signature"] as string | undefined });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const echoPort = (echo.address() as AddressInfo).port;

    const hookRes = await fetch(`${base}/api/v1/webhooks`, {
      method: "POST",
      headers: { ...bearer(tenantA, "admin"), "content-type": "application/json" },
      body: JSON.stringify({ url: `http://127.0.0.1:${echoPort}/hook`, events: ["lead.stage_changed"] }),
    });
    assert.equal(hookRes.status, 201);
    const hook = (await hookRes.json()) as { id: string; secret: string };
    assert.ok(hook.secret);

    const moveRes = await fetch(`${base}/api/v1/leads/${incoming.id}`, {
      method: "PATCH",
      headers: { ...bearer(tenantA, "admin"), "content-type": "application/json" },
      body: JSON.stringify({ stage_id: pipeline.stages[1]!.id }),
    });
    assert.equal(moveRes.status, 200);

    try {
      assert.equal(deliveries.length, 1, "expected exactly one webhook delivery");
      const expected = "sha256=" + createHmac("sha256", hook.secret).update(deliveries[0]!.body).digest("hex");
      assert.equal(deliveries[0]!.signature, expected);
      const payload = JSON.parse(deliveries[0]!.body) as { event: string; data: { id: string } };
      assert.equal(payload.event, "lead.stage_changed");
      assert.equal(payload.data.id, incoming.id);
    } finally {
      echo.closeAllConnections?.();
      await new Promise<void>((resolve, reject) => echo.close((err) => (err ? reject(err) : resolve())));
    }

    // readonly cannot mutate
    const readonly = await fetch(`${base}/api/v1/leads/${incoming.id}`, {
      method: "PATCH",
      headers: { ...bearer(tenantA, "readonly"), "content-type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    assert.equal(readonly.status, 403);

    // CSV export contains the imported lead
    const csvRes = await fetch(`${base}/api/v1/export/leads.csv`, { headers: bearer(tenantA, "admin") });
    const csv = await csvRes.text();
    assert.ok(csv.includes("Ada Byron"));

    // CSV import creates leads
    const importRes = await fetch(`${base}/api/v1/import/leads`, {
      method: "POST",
      headers: { ...bearer(tenantA, "admin"), "content-type": "text/csv" },
      body: "name,price,stage,tags\nImported One,100,Negotiation,vip\nImported Two,250,Incoming Leads,promo\n",
    });
    const importBody = (await importRes.json()) as { created: number; failed: number };
    assert.equal(importBody.created, 2);
    assert.equal(importBody.failed, 0);

    // audit log recorded the important actions
    const pool = connect(DATABASE_URL!);
    try {
      const audit = await withTenant(pool, tenantA, async (c) => {
        const r = await c.query("SELECT action, entity FROM audit_log");
        return r.rows;
      });
      const actions = audit.map((r: { entity: string; action: string }) => `${r.entity}:${r.action}`);
      assert.ok(actions.includes("pipeline:created"));
      assert.ok(actions.includes("incoming_lead:accepted"));
      assert.ok(actions.includes("lead:stage_changed"));
      assert.ok(actions.includes("webhook:created"));
    } finally {
      await pool.end();
    }
  });
});
