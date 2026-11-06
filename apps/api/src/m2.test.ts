/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation.
 *
 * M2 integration tests: WhatsApp inbox (fake provider). Requires
 * DATABASE_URL (knotwire_app) and migrations 0001-0003 applied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

import { connect, issueToken } from "@knotwire/core";
import { createApi } from "./server.js";
import { encryptField, decryptField, hashIdentity } from "./crypto.js";
import { isWithinServiceWindow } from "./whatsapp.js";

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

test("crypto roundtrip + identity hash stability", () => {
  const enc = encryptField("15551234567");
  assert.equal(decryptField(enc), "15551234567");
  assert.equal(hashIdentity("15551234567"), hashIdentity("15551234567"));
  assert.notEqual(hashIdentity("15551234567"), "15551234567");
});

test("service window: 24h from last inbound", () => {
  assert.equal(isWithinServiceWindow(new Date(Date.now() - 1000)), true);
  assert.equal(isWithinServiceWindow(new Date(Date.now() - 25 * 60 * 60 * 1000)), false);
  assert.equal(isWithinServiceWindow(null), false);
});

test("m2 integration (fake WhatsApp inbox)", { skip: DATABASE_URL ? false : "DATABASE_URL not set" }, async () => {
  const tenantA = await seedTenant("InboxA");
  const tenantB = await seedTenant("InboxB");

  await withServer(async (base) => {
    const h = bearer(tenantA, "admin");

    // channel connect
    const acc = await fetch(`${base}/api/v1/channels/whatsapp/accounts`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ provider_account_id: "waba_test_1", access_token: "fake-token", verify_token: "vt-test-123" }),
    });
    assert.equal(acc.status, 201);

    const listAcc = await fetch(`${base}/api/v1/channels/whatsapp/accounts`, { headers: h });
    const accBody = (await listAcc.json()) as { accounts: Array<Record<string, unknown>> };
    assert.equal(accBody.accounts.length, 1);
    assert.equal("access_token_enc" in accBody.accounts[0]!, false);

    // bad signature rejected
    const badBody = JSON.stringify({ messages: [{ from: "15559999999", text: { body: "hi" } }] });
    const badSig = await fetch(`${base}/api/v1/channels/whatsapp/webhook`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      body: badBody,
    });
    assert.equal(badSig.status, 403);

    // good signature accepted; inbound stored under RLS
    const goodSig =
      "sha256=" + createHmac("sha256", "vt-test-123").update(badBody).digest("hex");
    const good = await fetch(`${base}/api/v1/channels/whatsapp/webhook`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "x-hub-signature-256": goodSig },
      body: badBody,
    });
    assert.equal(good.status, 200);
    const goodBody = (await good.json()) as { accepted: number };
    assert.equal(goodBody.accepted, 1);

    // inbox lists the conversation; wa_id is decrypted in API shape
    const convs = await fetch(`${base}/api/v1/conversations`, { headers: h });
    const convBody = (await convs.json()) as { conversations: Array<{ id: string; wa_id: string; status: string }> };
    assert.equal(convBody.conversations.length, 1);
    assert.equal(convBody.conversations[0]!.wa_id, "15559999999");
    const conversationId = convBody.conversations[0]!.id;

    // cross-tenant: B sees no conversations
    const bConvs = await fetch(`${base}/api/v1/conversations`, { headers: bearer(tenantB, "agent") });
    const bBody = (await bConvs.json()) as { conversations: unknown[] };
    assert.equal(bBody.conversations.length, 0);

    // thread read: window open (inbound just happened)
    const thread = await fetch(`${base}/api/v1/conversations/${conversationId}`, { headers: h });
    const threadBody = (await thread.json()) as { service_window: { open: boolean }; messages: Array<{ direction: string; body: string }> };
    assert.equal(threadBody.service_window.open, true);
    assert.equal(threadBody.messages[0]!.body, "hi");

    // send text within window
    const send = await fetch(`${base}/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello back 👋" }),
    });
    assert.equal(send.status, 201);

    // internal team note (never sent to wa provider)
    const note = await fetch(`${base}/api/v1/conversations/${conversationId}/internal-notes`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ body: "interested lead, follow up Tuesday" }),
    });
    const noteBody = (await note.json()) as { is_internal: boolean };
    assert.equal(noteBody.is_internal, true);

    // backdate the inbound message, window closes
    const raw = connect(DATABASE_URL!);
    try {
      await raw.query(
        "SET app.tenant_id=$1",
        [tenantA],
      ).catch(() => undefined);
      // direct update as app role with GUC on a dedicated client
    } finally {
      await raw.end();
    }
    const setter = connect(DATABASE_URL!);
    const client = await setter.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);
    await client.query("UPDATE messages SET sent_at = sent_at - interval '25 hours' WHERE conversation_id=$1 AND direction='inbound'", [conversationId]);
    await client.query("UPDATE conversations SET last_message_at = last_message_at - interval '25 hours' WHERE id=$1", [conversationId]);
    await client.query("COMMIT");
    client.release();
    await setter.end();

    const thread2 = await fetch(`${base}/api/v1/conversations/${conversationId}`, { headers: h });
    const threadBody2 = (await thread2.json()) as { service_window: { open: boolean } };
    assert.equal(threadBody2.service_window.open, false);

    // plain text now rejected; template required
    const blocked = await fetch(`${base}/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ text: "are you still there?" }),
    });
    assert.equal(blocked.status, 409);

    // register + approve template, then send via template
    const tpl = await fetch(`${base}/api/v1/templates`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ name: "reengagement_v1" }),
    });
    assert.equal(tpl.status, 201);
    const tplBody = (await tpl.json()) as { id: string };
    const submitted = await fetch(`${base}/api/v1/templates/${tplBody.id}/submit`, {
      method: "POST",
      headers: h,
    });
    assert.equal(submitted.status, 200);
    const tplSend = await fetch(`${base}/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ text: "We miss you", template_name: "reengagement_v1" }),
    });
    assert.equal(tplSend.status, 201);

    // opt-out blocks everything
    const optOut = await fetch(`${base}/api/v1/conversations/${conversationId}/opt-out`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ reason: "user said STOP" }),
    });
    assert.equal(optOut.status, 200);
    const afterOptOut = await fetch(`${base}/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", template_name: "reengagement_v1" }),
    });
    assert.equal(afterOptOut.status, 409);

    // inbox page renders
    const inbox = await fetch(`${base}/inbox`);
    assert.equal(inbox.status, 200);
    assert.ok((inbox.headers.get("content-type") ?? "").startsWith("text/html"));
  });
});
