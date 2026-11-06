/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation.
 *
 * M4: dialog engine unit tests (golden) + integration (trigger → session → replies).
 * Requires DATABASE_URL (knotwire_app) and migrations 0001-0005.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

import { connect, issueToken, runDialogOnce, validateSteps, render, type DialogBot, type SessionState } from "@knotwire/core";
import { createApi } from "./server.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const SECRET = "test-secret";

const newSession = (): SessionState => ({ botId: "b", currentStep: 0, variables: {}, state: "active", waitingStep: -1 });

const ctx = () => ({ lead: { id: "l1", name: "L", custom_fields: {}, tags: [] as string[] }, contact: null, messageText: "", botName: "b" });

test("engine: ask/validate/branch golden run", () => {
  const bot: DialogBot = {
    id: "b",
    name: "greet",
    status: "published",
    version: 1,
    steps: [
      { t: "say", text: "Hi! What's your email?" },
      { t: "ask", text: "email?", var: "email" },
      { t: "validate", var: "email", kind: "email", on_pass: 5, on_fail: 3 },
      { t: "say", text: "That email looks off, try again" },
      { t: "goto", step: 1 },
      { t: "say", text: "Thanks {{vars.email}}" },
      { t: "stop" },
    ],
  };
  let s = newSession();
  let out = runDialogOnce(bot, s, undefined, ctx());
  assert.deepEqual(out.sent, ["Hi! What's your email?", "email?"]);
  s = out.session;
  out = runDialogOnce(bot, s, "not-an-email", ctx());
  // validate fails → jump to 4 (bad email msg) → goto 1 → re-ask email
  assert.ok(out.sent.includes("That email looks off, try again"));
  assert.ok(out.sent.includes("email?"));
  s = out.session;
  out = runDialogOnce(bot, s, "ada@example.com", ctx());
  assert.ok(out.sent.includes("Thanks ada@example.com"));
  assert.equal(out.finished, true);
});

test("engine: condition + buttons branch", () => {
  const bot: DialogBot = {
    id: "b",
    name: "choice",
    status: "published",
    version: 1,
    steps: [
      { t: "buttons", text: "Pick:", options: ["Yes", "No"] },
      { t: "condition", var: "_choice", op: "eq", value: "Yes", then: 2, else: 3 },
      { t: "say", text: "Great" },
      { t: "say", text: "Never mind" },
      { t: "stop" },
    ],
  };
  let s = newSession();
  let out = runDialogOnce(bot, s, undefined, ctx());
  assert.ok(out.sent[0]?.includes("Pick:"));
  s = out.session;
  out = runDialogOnce(bot, s, "Yes", ctx());
  assert.ok(out.sent.includes("Great"));
  assert.equal(out.finished, true);
});

test("engine: loop guard + find_contact action + unknown step", () => {
  const loopBot: DialogBot = { id: "b", name: "loop", status: "published", version: 1, steps: [{ t: "goto", step: 0 }] };
  let out = runDialogOnce(loopBot, newSession(), undefined, ctx());
  assert.equal(out.error, "step_loop_exceeded");

  const findBot: DialogBot = { id: "b", name: "f", status: "published", version: 1, steps: [{ t: "find_contact", var: "phone" }, { t: "stop" }] };
  out = runDialogOnce(findBot, newSession(), undefined, ctx());
  assert.deepEqual(out.actions, [{ kind: "find_contact", var: "phone" }]);
  assert.equal(out.finished, true);

  const bad = validateSteps([{ t: "nope" }, { t: "ask" }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 2);
});

test("engine: rendering", () => {
  assert.equal(render("Hi {{contact.name}} / {{vars.x}}", { lead: null, contact: { name: "Ann" }, botName: "b" }, { x: 1 }), "Hi Ann / 1");
});

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

test("m4 integration (dialog trigger → session → replies)", { skip: DATABASE_URL ? false : "DATABASE_URL not set" }, async () => {
  const tenantA = await seedTenant("DialogA");
  await withServer(async (base) => {
    const h = bearer(tenantA, "admin");

    // connect whatsapp channel for the conversation
    const acc = await fetch(`${base}/api/v1/channels/whatsapp/accounts`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ provider_account_id: "waba_dlg", access_token: "fake", verify_token: "vt-dlg" }),
    });
    assert.equal(acc.status, 201);

    // a lead to attach (created via API)
    const lead = await fetch(`${base}/api/v1/leads`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ name: "Test Lead" }),
    });
    assert.equal(lead.status, 201);
    const leadBody = (await lead.json()) as { id: string };

    // first inbound creates the conversation (no bot yet -> no session)
    const inboundBody = JSON.stringify({ messages: [{ from: "15551112222", text: { body: "hi" } }] });
    const sigTurn1 = "sha256=" + createHmac("sha256", "vt-dlg").update(inboundBody).digest("hex");
    const inbound = await fetch(`${base}/api/v1/channels/whatsapp/webhook`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "x-hub-signature-256": sigTurn1 },
      body: inboundBody,
    });
    assert.equal(inbound.status, 200);
    const convs = await fetch(`${base}/api/v1/conversations`, { headers: h });
    const convBody = (await convs.json()) as { conversations: Array<{ id: string }> };
    const convId = convBody.conversations[0]!.id;

    // create + publish bot
    const bot = await fetch(`${base}/api/v1/dialogs`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({
        name: "greeter",
        steps: [
          { t: "say", text: "Hello from Knotwire!" },
          { t: "ask", text: "What's your name?", var: "name" },
          { t: "set_lead_field", key: "contact_name", value: "{{vars.name}}" },
          { t: "set_tag", value: "greeted" },
          { t: "say", text: "Nice to meet you, {{vars.name}}" },
          { t: "stop" },
        ],
      }),
    });
    assert.equal(bot.status, 201);
    const botBody = (await bot.json()) as { id: string };
    const pub = await fetch(`${base}/api/v1/dialogs/${botBody.id}/publish`, { method: "POST", headers: h });
    assert.equal(pub.status, 201);

    // trigger on message_received (fires for later inbound turns)
    const trig = await fetch(`${base}/api/v1/dialogs/${botBody.id}/triggers`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ kind: "message_received", filter: {} }),
    });
    assert.equal(trig.status, 201);

    // launch on the lead+conversation: say + ask are sent, session waits
    const launch = await fetch(`${base}/api/v1/dialogs/${botBody.id}/launch`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ lead_id: leadBody.id, conversation_id: convId }),
    });
    assert.equal(launch.status, 201);

    // reply with a name → bot stores it, sets field + tag, says goodbye
    const replyBody = JSON.stringify({ messages: [{ from: "15551112222", text: { body: "Ada" } }] });
    const sigTurn2 = "sha256=" + createHmac("sha256", "vt-dlg").update(replyBody).digest("hex");
    const reply = await fetch(`${base}/api/v1/channels/whatsapp/webhook`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json", "x-hub-signature-256": sigTurn2 },
      body: replyBody,
    });
    assert.equal(reply.status, 200);

    const thread = await fetch(`${base}/api/v1/conversations/${convId}`, { headers: h });
    const threadBody = (await thread.json()) as { messages: Array<{ direction: string; body: string | null }> };
    const bodies = threadBody.messages.map((m) => m.body ?? "");
    assert.ok(bodies.some((b) => b.includes("Hello from Knotwire!")), "bot greeted");
    assert.ok(bodies.some((b) => b.includes("Nice to meet you, Ada")), "bot personalized");

    // lead got field + tag
    const lead2 = await fetch(`${base}/api/v1/leads/${leadBody.id}`, { headers: h });
    const leadBody2 = (await lead2.json()) as { custom_fields: Record<string, unknown>; tags: string[] };
    assert.equal(leadBody2.custom_fields["contact_name"], "Ada");
    assert.ok(leadBody2.tags.includes("greeted"));

    // sessions listed
    const sessions = await fetch(`${base}/api/v1/dialogs/${botBody.id}/sessions`, { headers: h });
    const sessionsBody = (await sessions.json()) as { sessions: Array<{ state: string }> };
    assert.ok(sessionsBody.sessions.length >= 1);
    assert.equal(sessionsBody.sessions[0]!.state, "finished");

    // simulate without writes
    const sim = await fetch(`${base}/api/v1/dialogs/${botBody.id}/simulate`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify({ replies: ["Grace"] }),
    });
    const simBody = (await sim.json()) as { transcript: Array<{ sent: string[] }> };
    assert.ok(simBody.transcript.some((t) => t.sent.some((s) => s.includes("Grace"))));
  });
});
