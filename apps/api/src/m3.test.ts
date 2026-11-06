/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation.
 *
 * M3 integration tests: Facebook Messenger + lead forms + m.me attribution.
 * Requires DATABASE_URL (knotwire_app) and migrations 0001-0004 applied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

import { connect, issueToken } from "@knotwire/core";
import { createApi } from "./server.js";
import { parseMeRef } from "./facebook.js";

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

test("m.me ref parsing", () => {
  assert.deepEqual(parseMeRef("mk_campaign42"), { ref: "mk_campaign42", kind: "marketplace" });
  assert.deepEqual(parseMeRef("ad_winter"), { ref: "ad_winter", kind: "facebook-ad" });
  assert.deepEqual(parseMeRef("email_cta"), { ref: "email_cta", kind: "referral" });
  assert.deepEqual(parseMeRef(null), { ref: "", kind: "unknown" });
});

test("m3 integration (Messenger + lead forms + attribution)", { skip: DATABASE_URL ? false : "DATABASE_URL not set" }, async () => {
  const tenantA = await seedTenant("FbA");
  const tenantB = await seedTenant("FbB");

  await withServer(async (base) => {
    const h = bearer(tenantA, "admin");

    // hub challenge
    const challenge = await fetch(`${base}/api/v1/channels/facebook/webhook?hub.mode=subscribe&hub.verify_token=abc&hub.challenge=12345`, { headers: h });
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(), "12345");

    // connect messenger page
    const acc = await fetch(`${base}/api/v1/channels/facebook/accounts`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ page_id: "page_123", page_access_token: "fake-page-token", verify_token: "fb-vt-123" }),
    });
    assert.equal(acc.status, 201);

    // bad signature rejected
    const payload = JSON.stringify({
      object: "page",
      entry: [{
        id: "page_123",
        messaging: [{
          sender: { id: "psid_1" },
          recipient: { id: "page_123" },
          timestamp: Date.now(),
          postback: { payload: "GET_STARTED", referral: { ref: "mk_shoes99", source: "messenger", source_url: "https://www.facebook.com/marketplace/item/456/" } },
        }],
      }],
    });
    const bad = await fetch(`${base}/api/v1/channels/facebook/webhook`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      body: payload,
    });
    assert.equal(bad.status, 403);

    const sig = "sha256=" + createHmac("sha256", "fb-vt-123").update(payload).digest("hex");
    const good = await fetch(`${base}/api/v1/channels/facebook/webhook`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "x-hub-signature-256": sig },
      body: payload,
    });
    assert.equal(good.status, 200);
    const goodBody = (await good.json()) as { accepted: number };
    assert.equal(goodBody.accepted, 1);

    // conversation carries marketplace attribution
    const convs = await fetch(`${base}/api/v1/conversations`, { headers: h });
    const convBody = (await convs.json()) as { conversations: Array<{ id: string; channel: string; wa_id: string; status: string }> };
    const fb = convBody.conversations.find((c) => c.channel === "facebook-messenger");
    assert.ok(fb, "messenger conversation present");
    assert.equal(fb!.wa_id, "psid_1");

    // lead forms -> incoming leads
    const leadPayload = JSON.stringify({
      object: "page",
      entry: [{
        id: "page_123",
        changes: [{
          field: "leadgen",
          value: {
            leadgen_id: "lg_1",
            page_id: "page_123",
            form_id: "form_winter",
            field_data: [
              { name: "name", values: ["Grace Hopper"] },
              { name: "email", values: ["grace@example.com"] },
              { name: "phone_number", values: ["+15550001111"] },
            ],
          },
        }],
      }],
    });
    const leadSig = "sha256=" + createHmac("sha256", "fb-vt-123").update(leadPayload).digest("hex");
    const leadgen = await fetch(`${base}/api/v1/channels/facebook/lead-forms/webhook`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "x-hub-signature-256": leadSig },
      body: leadPayload,
    });
    assert.equal(leadgen.status, 200);
    const leadBody = (await leadgen.json()) as { created: number };
    assert.equal(leadBody.created, 1);

    // incoming queue shows the lead
    const incoming = await fetch(`${base}/api/v1/incoming-leads`, { headers: h });
    const incomingBody = (await incoming.json()) as { leads: Array<{ name: string; incoming: boolean; tags: string[]; source_kind: string }> };
    const found = incomingBody.leads.find((l) => l.name === "Grace Hopper");
    assert.ok(found, "lead-form lead present");
    assert.equal(found!.source_kind, "facebook-lead-ad");
    assert.ok(found!.tags.includes("facebook-lead-ad"));

    // attribution stats for the marketplace ref
    const attr = await fetch(`${base}/api/v1/attribution?ref=mk_shoes99`, { headers: h });
    const attrBody = (await attr.json()) as { ref: string; conversations: number; leads: number; kinds: Array<{ kind: string; n: number }> };
    assert.equal(attrBody.ref, "mk_shoes99");
    assert.equal(attrBody.conversations, 1);
    assert.equal(attrBody.kinds[0]!.kind, "marketplace");

    // cross-tenant: B sees no conversations, no attribution
    const bConvs = await fetch(`${base}/api/v1/conversations`, { headers: bearer(tenantB, "agent") });
    const bConvBody = (await bConvs.json()) as { conversations: unknown[] };
    assert.equal(bConvBody.conversations.length, 0);
    const bAttr = await fetch(`${base}/api/v1/attribution?ref=mk_shoes99`, { headers: bearer(tenantB, "agent") });
    const bAttrBody = (await bAttr.json()) as { conversations: number };
    assert.equal(bAttrBody.conversations, 0);
  });
});
