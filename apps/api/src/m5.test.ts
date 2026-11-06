/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation.
 *
 * M5: AI agent (fake provider) + copilot. Requires DATABASE_URL and
 * migrations 0001-0006.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

import { connect, issueToken, withTenant } from "@knotwire/core";
import { createApi } from "./server.js";
import { FakeLlmClient } from "./llm.js";

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

const bearer = (tenantId: string, role: string) =>
  ({ authorization: `Bearer ${issueToken({ sub: "11111111-1111-4111-8111-111111111111", tenantId, role }, SECRET, 600)}` });

test("fake llm: deterministic turns", async () => {
  const client = new FakeLlmClient();
  const kb = [{ title: "FAQ", content: "Returns are free within 30 days of purchase" }];
  const hit = await client.complete({ system: "", messages: [{ role: "user", text: "What is your returns policy?" }], tools: [], knowledge: kb });
  assert.ok(hit.turn.text.includes("Returns are free"));
  const price = await client.complete({ system: "", messages: [{ role: "user", text: "price of shoes?" }], tools: ["lookup_product"], knowledge: [] });
  assert.equal(price.turn.toolCalls[0]?.name, "lookup_product");
  const human = await client.complete({ system: "", messages: [{ role: "user", text: "talk to a human please" }], tools: ["hand_off"], knowledge: [] });
  assert.equal(human.turn.toolCalls[0]?.name, "hand_off");
});

test("m5 integration (agent runtime + copilot)", { skip: DATABASE_URL ? false : "DATABASE_URL not set" }, async () => {
  const tenantA = await seedTenant("AiA");
  await withServer(async (base) => {
    const h = bearer(tenantA, "admin");

    // connect whatsapp channel
    const acc = await fetch(`${base}/api/v1/channels/whatsapp/accounts`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ provider_account_id: "waba_ai", access_token: "fake", verify_token: "vt-ai" }),
    });
    assert.equal(acc.status, 201);

    // knowledge source + agent
    const src = await fetch(`${base}/api/v1/ai/sources`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ title: "FAQ", kind: "text", content: "Returns are free within 30 days of purchase, no questions asked" }),
    });
    assert.equal(src.status, 201);

    const agent = await fetch(`${base}/api/v1/ai/agents`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ name: "sales-bot", system_prompt: "You sell shoes." }),
    });
    assert.equal(agent.status, 201);
    const agentBody = (await agent.json()) as { id: string };
    const pub = await fetch(`${base}/api/v1/ai/agents/${agentBody.id}/publish`, { method: "POST", headers: h });
    assert.equal(pub.status, 200);

    // user asks about returns -> KB answer recorded in thread
    const body1 = JSON.stringify({ messages: [{ from: "15559998888", text: { body: "What is your returns policy?" } }] });
    const sig = (b: string) => "sha256=" + createHmac("sha256", "vt-ai").update(b).digest("hex");
    const res1 = await fetch(`${base}/api/v1/channels/whatsapp/webhook`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "x-hub-signature-256": sig(body1) },
      body: body1,
    });
    assert.equal(res1.status, 200);

    const convs = await fetch(`${base}/api/v1/conversations`, { headers: h });
    const convBody = (await convs.json()) as { conversations: Array<{ id: string }> };
    const convId = convBody.conversations[0]!.id;
    const thread = await fetch(`${base}/api/v1/conversations/${convId}`, { headers: h });
    const threadBody = (await thread.json()) as { messages: Array<{ direction: string; body: string | null }> };
    const bodies = threadBody.messages.map((m) => m.body ?? "");
    assert.ok(bodies.some((b) => b.includes("Returns are free")), "KB answer in thread");

    // usage logged
    const pool = connect(DATABASE_URL!);
    let usage = 0;
    try {
      const r = await withTenant(pool, tenantA, async (c) => c.query("SELECT count(*)::int AS n FROM ai_usage"));
      usage = r.rows[0].n as number;
    } finally {
      await pool.end();
    }
    assert.ok(usage >= 1, "usage row recorded");

    // copilot rewrite + suggest
    const rewrite = await fetch(`${base}/api/v1/ai/copilot/rewrite`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ text: "Hey!! Let me give you 50% off!!!", tone: "friendly" }),
    });
    const rewriteBody = (await rewrite.json()) as { rewritten: string };
    assert.ok(rewriteBody.rewritten.length > 0);

    const suggest = await fetch(`${base}/api/v1/ai/copilot/suggest-reply`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ conversation_id: convId }),
    });
    const suggestBody = (await suggest.json()) as { suggestion: string };
    assert.ok(suggestBody.suggestion.length > 0);
  });
});
