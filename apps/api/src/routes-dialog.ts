/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * Dialog engine HTTP surface (fake providers; real Meta providers later):
 *   GET  /api/v1/dialogs                          list bots (draft+published)
 *   POST /api/v1/dialogs                          create draft bot
 *   GET  /api/v1/dialogs/:id                      bot detail
 *   PUT  /api/v1/dialogs/:id                      replace steps (draft only)
 *   POST /api/v1/dialogs/:id/publish              draft -> published (new version)
 *   GET  /api/v1/dialogs/:id/triggers             list triggers
 *   POST /api/v1/dialogs/:id/triggers             add trigger {kind, filter}
 *   GET  /api/v1/dialogs/:id/sessions             list sessions
 *   POST /api/v1/dialogs/:id/simulate             dry-run vs fixtures (no writes)
 *   POST /api/v1/dialogs/:id/launch               manual launch on lead/conversation
 *
 * Runtime hooks (called from inbox ingest + lead create): `onLeadCreated`,
 * `onInboundMessage` — match published triggers and advance sessions.
 */

import type pg from "pg";
import { withTenant, runDialogOnce, validateSteps, type DialogBot, type DialogStep, type SessionState } from "@knotwire/core";
import type { RequestContext } from "./context.js";
import { requireWriteRole } from "./context.js";
import type { HandlerResult } from "./routes-crm.js";
import { writeAudit } from "./audit.js";
import { decryptField, hashIdentity } from "./crypto.js";
import { FakeWhatsAppClient } from "./whatsapp.js";
import { FakeMessengerClient } from "./facebook.js";
import { recordMessage } from "./routes-inbox.js";

const asUuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

const text = (v: unknown, max = 1000): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const jsonArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const jsonObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function toBot(row: Record<string, unknown>): DialogBot {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    status: row["status"] as "draft" | "published",
    version: row["version"] as number,
    steps: jsonArr(row["steps"]) as DialogStep[],
  };
}

// ---------- CRUD ----------

export async function listDialogs(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, name, status, version, steps, created_at, updated_at FROM bots ORDER BY name, version DESC");
    return r.rows;
  });
  return { status: 200, body: { bots: rows } };
}

export async function createDialog(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 200);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const steps = jsonArr(body["steps"]);
  const validation = validateSteps(steps);
  if (!validation.ok) return { status: 400, body: { error: "invalid_steps", errors: validation.errors } };
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO bots (tenant_id, name, status, version, steps) VALUES ($1,$2,'draft',1,$3) RETURNING id, name, status, version, steps, created_at, updated_at",
      [ctx.tenantId, name, JSON.stringify(steps)],
    );
    await writeAudit(c, ctx, { entity: "bot", entityId: r.rows[0].id, action: "created", after: r.rows[0], before: null });
    return r.rows[0] as Record<string, unknown>;
  });
  return { status: 201, body: row };
}

export async function getDialog(pool: pg.Pool, ctx: RequestContext, botId: string): Promise<HandlerResult> {
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, name, status, version, steps, created_at, updated_at FROM bots WHERE id=$1", [botId]);
    return r.rows[0] ?? null;
  });
  if (!row) return { status: 404, body: { error: "bot_not_found" } };
  return { status: 200, body: row };
}

export async function updateDialog(pool: pg.Pool, ctx: RequestContext, botId: string, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const cur = await c.query("SELECT status FROM bots WHERE id=$1", [botId]);
    if (cur.rowCount === 0) return { missing: true as const };
    if (cur.rows[0].status !== "draft") return { locked: true as const };
    const steps = jsonArr(body["steps"]);
    const validation = validateSteps(steps);
    if (!validation.ok) return { errors: validation.errors };
    const r = await c.query("UPDATE bots SET steps=$2 WHERE id=$1 RETURNING id, name, status, version, steps, updated_at", [botId, JSON.stringify(steps)]);
    return { row: r.rows[0] as Record<string, unknown> };
  });
  if ("missing" in row) return { status: 404, body: { error: "bot_not_found" } };
  if ("locked" in row) return { status: 409, body: { error: "published_bots_are_immutable" } };
  if ("errors" in row) return { status: 400, body: { error: "invalid_steps", errors: row.errors } };
  return { status: 200, body: row.row };
}

export async function publishDialog(pool: pg.Pool, ctx: RequestContext, botId: string): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const cur = await c.query("SELECT * FROM bots WHERE id=$1", [botId]);
    if (cur.rowCount === 0) return { missing: true as const };
    const bot = cur.rows[0];
    if (bot.status === "published") return { already: true as const };
    const next = await c.query(
      "INSERT INTO bots (tenant_id, name, status, version, steps) VALUES ($1,$2,'published',$3,$4) RETURNING id, name, status, version, steps, created_at, updated_at",
      [ctx.tenantId, bot.name, (bot.version as number) + 1, JSON.stringify(bot.steps)],
    );
    await c.query("UPDATE bots SET status='published' WHERE id=$1", [botId]);
    return { row: next.rows[0] as Record<string, unknown> };
  });
  if ("missing" in row) return { status: 404, body: { error: "bot_not_found" } };
  if ("already" in row) return { status: 200, body: { published: true } };
  return { status: 201, body: row.row };
}

// ---------- triggers ----------

export async function listTriggers(pool: pg.Pool, ctx: RequestContext, botId: string): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, kind, filter, active, created_at FROM bot_triggers WHERE bot_id=$1 ORDER BY created_at DESC", [botId]);
    return r.rows;
  });
  return { status: 200, body: { triggers: rows } };
}

const TRIGGER_KINDS = new Set(["message_received", "lead_created", "stage_changed", "manual"]);

export async function addTrigger(pool: pg.Pool, ctx: RequestContext, botId: string, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const kind = text(body["kind"], 50);
  if (!kind || !TRIGGER_KINDS.has(kind)) return { status: 400, body: { error: "invalid_kind" } };
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const bot = await c.query("SELECT id FROM bots WHERE id=$1", [botId]);
    if (bot.rowCount === 0) return null;
    const r = await c.query(
      "INSERT INTO bot_triggers (tenant_id, bot_id, kind, filter) VALUES ($1,$2,$3,$4) RETURNING *",
      [ctx.tenantId, botId, kind, JSON.stringify(jsonObj(body["filter"]))],
    );
    return r.rows[0] as Record<string, unknown>;
  });
  if (!row) return { status: 404, body: { error: "bot_not_found" } };
  return { status: 201, body: row };
}

// ---------- sessions ----------

export async function listSessions(pool: pg.Pool, ctx: RequestContext, botId: string): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, conversation_id, lead_id, current_step, variables, state, last_reply, last_step_at, created_at FROM bot_sessions WHERE bot_id=$1 ORDER BY created_at DESC LIMIT 100",
      [botId],
    );
    return r.rows;
  });
  return { status: 200, body: { sessions: rows } };
}

async function loadPublishedBot(pool: pg.Pool, ctx: RequestContext, botId: string): Promise<DialogBot | null> {
  return withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, name, status, version, steps FROM bots WHERE id=$1 AND status='published' ORDER BY version DESC LIMIT 1", [botId]);
    return r.rows[0] ? toBot(r.rows[0] as Record<string, unknown>) : null;
  });
}

async function persistSession(
  pool: pg.Pool,
  ctx: RequestContext,
  botId: string,
  session: SessionState,
  existingSessionId: string | null,
  conversationId: string | null,
): Promise<string> {
  return withTenant(pool, ctx.tenantId, async (c) => {
    if (existingSessionId) {
      await c.query(
        "UPDATE bot_sessions SET current_step=$2, waiting_step=$3, variables=$4, state=$5, last_reply=$6, last_step_at=now() WHERE id=$1",
        [existingSessionId, session.currentStep, session.waitingStep ?? null, JSON.stringify(session.variables), session.state, session.lastReply ?? null],
      );
      return existingSessionId;
    }
    const r = await c.query(
      "INSERT INTO bot_sessions (tenant_id, bot_id, conversation_id, lead_id, current_step, waiting_step, variables, state, last_reply) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
      [ctx.tenantId, botId, conversationId, session.leadId ?? null, session.currentStep, session.waitingStep ?? null, JSON.stringify(session.variables), session.state, session.lastReply ?? null],
    );
    return r.rows[0].id as string;
  });
}

async function applyActions(
  pool: pg.Pool,
  ctx: RequestContext,
  session: SessionState,
  actions: Array<{ kind: string; [key: string]: unknown }>,
): Promise<void> {
  if (!session.leadId) return;
  await withTenant(pool, ctx.tenantId, async (c) => {
    for (const action of actions) {
      if (action.kind === "set_lead_field") {
        const key = String(action["key"]);
        const value = String(action["value"]);
        await c.query(
          "UPDATE leads SET custom_fields = custom_fields || jsonb_build_object($2::text, $3::text) WHERE id=$1",
          [session.leadId, key, value],
        );
      } else if (action.kind === "add_tag") {
        await c.query("UPDATE leads SET tags = array_append(tags, $2::text) WHERE id=$1 AND NOT ($2::text = ANY(tags))", [session.leadId, String(action["value"])]);
      } else if (action.kind === "remove_tag") {
        await c.query("UPDATE leads SET tags = array_remove(tags, $2::text) WHERE id=$1", [session.leadId, String(action["value"])]);
      } else if (action.kind === "move_stage") {
        const stageId = action["stageId"] ? String(action["stageId"]) : null;
        const stageName = action["stageName"] ? String(action["stageName"]) : null;
        if (stageId) {
          await c.query("UPDATE leads SET stage_id=$2::uuid WHERE id=$1", [session.leadId, stageId]);
        } else if (stageName) {
          await c.query("UPDATE leads SET stage_id = (SELECT id FROM stages WHERE name=$2 LIMIT 1) WHERE id=$1", [session.leadId, stageName]);
        }
      } else if (action.kind === "create_task") {
        await c.query("INSERT INTO tasks (tenant_id, lead_id, title) VALUES ($1,$2::uuid,$3::text)", [ctx.tenantId, session.leadId, String(action["title"])]);
      } else if (action.kind === "add_note") {
        await c.query("INSERT INTO notes (tenant_id, lead_id, body, created_by) VALUES ($1,$2::uuid,$3::text,$4::uuid)", [ctx.tenantId, session.leadId, String(action["text"]), ctx.userId]);
      } else if (action.kind === "assign") {
        await c.query("UPDATE leads SET responsible_user_id=$2::uuid WHERE id=$1", [session.leadId, action["userId"] ? String(action["userId"]) : null]);
      }
    }
  });
}

export interface RuntimeClients {
  whatsapp: Map<string, FakeWhatsAppClient>;
  messenger: Map<string, FakeMessengerClient>;
}

/** Advance one session with an optional reply; sends outgoing lines via fakes. */
async function advanceSession(
  pool: pg.Pool,
  ctx: RequestContext,
  bot: DialogBot,
  sessionId: string | null,
  session: SessionState,
  reply: string | undefined,
  conversation: { id: string; channel: string; waId: string } | null,
  clients: RuntimeClients,
): Promise<SessionState> {
  const lead = session.leadId
    ? await withTenant(pool, ctx.tenantId, async (c) => {
        const r = await c.query("SELECT id, name, price, custom_fields, tags FROM leads WHERE id=$1", [session.leadId]);
        return (r.rows[0] as Record<string, unknown> | undefined) ?? null;
      })
    : null;
  const outcome = runDialogOnce(bot, session, reply, {
    lead: lead ? { id: lead["id"] as string, name: lead["name"] as string, price: lead["price"], custom_fields: jsonObj(lead["custom_fields"]), tags: Array.isArray(lead["tags"]) ? (lead["tags"] as string[]) : [] } : null,
    contact: null,
    messageText: reply,
    botName: bot.name,
  });

  if (conversation && outcome.sent.length) {
    // send through the channel fake so transcripts are observable
    for (const line of outcome.sent) {
      if (conversation.channel === "facebook-messenger") {
        let client = clients.messenger.get(ctx.tenantId);
        if (!client) {
          client = new FakeMessengerClient();
          clients.messenger.set(ctx.tenantId, client);
        }
        await client.sendText({ recipientId: conversation.waId, text: line });
      } else {
        let client = clients.whatsapp.get(ctx.tenantId);
        if (!client) {
          client = new FakeWhatsAppClient();
          clients.whatsapp.set(ctx.tenantId, client);
        }
        await client.sendText({ to: conversation.waId, text: line });
      }
      await withTenant(pool, ctx.tenantId, async (c) => {
        await recordMessage(c, ctx, {
          conversationId: conversation.id,
          providerMessageId: null,
          direction: "outbound",
          type: "text",
          body: line,
          deliveryStatus: "sent",
          createdByUserId: ctx.userId,
        });
      });
    }
  }

  await applyActions(pool, ctx, outcome.session, outcome.actions);
  await persistSession(pool, ctx, bot.id, outcome.session, sessionId, conversation?.id ?? null);
  return outcome.session;
}

// ---------- runtime hooks ----------

export interface HookContext {
  leadId?: string | undefined;
  conversationId?: string | undefined;
  messageText?: string | undefined;
}

async function resolveConversation(pool: pg.Pool, ctx: RequestContext, conversationId: string): Promise<{ id: string; channel: string; waId: string } | null> {
  return withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, channel, external_id_enc FROM conversations WHERE id=$1", [conversationId]);
    if (r.rowCount === 0) return null;
    return { id: r.rows[0].id as string, channel: r.rows[0].channel as string, waId: decryptField(r.rows[0].external_id_enc as string) };
  });
}

export async function onLeadCreated(pool: pg.Pool, ctx: RequestContext, hook: HookContext, clients: RuntimeClients): Promise<void> {
  const triggers = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `SELECT bt.bot_id, b.name, b.steps FROM bot_triggers bt JOIN bots b ON b.id=bt.bot_id
       WHERE bt.kind='lead_created' AND bt.active=true AND b.status='published'
       ORDER BY b.version DESC LIMIT 5`,
    );
    return r.rows as Array<{ bot_id: string; name: string; steps: unknown[] }>;
  });
  for (const trigger of triggers) {
    const bot: DialogBot = { id: trigger.bot_id, name: trigger.name, status: "published", version: 0, steps: trigger.steps as DialogStep[] };
    const conversation = hook.conversationId ? await resolveConversation(pool, ctx, hook.conversationId) : null;
    await advanceSession(pool, ctx, bot, null, { botId: bot.id, currentStep: 0, variables: {}, state: "active", leadId: hook.leadId }, undefined, conversation, clients).catch(() => undefined);
  }
}

export async function onInboundMessage(pool: pg.Pool, ctx: RequestContext, hook: HookContext, clients: RuntimeClients): Promise<void> {
  if (!hook.conversationId) return;
  // resume existing active session for this conversation
  const active = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, bot_id, current_step, waiting_step, variables, state, lead_id, last_reply FROM bot_sessions WHERE conversation_id=$1 AND state='active' ORDER BY created_at DESC LIMIT 1",
      [hook.conversationId],
    );
    return r.rows[0] ?? null;
  });
  // Lead-first adoption: a bot launched on a lead (no conversation yet)
  // adopts the first conversation that asks back.
  const orphan = active
    ? null
    : await withTenant(pool, ctx.tenantId, async (c) => {
        const r = await c.query(
          `SELECT bs.id, bs.bot_id, bs.current_step, bs.waiting_step, bs.variables, bs.state, bs.lead_id, bs.last_reply
           FROM bot_sessions bs JOIN bot_triggers bt ON bt.bot_id=bs.bot_id AND bt.kind='message_received' AND bt.active=true
           WHERE bs.conversation_id IS NULL AND bs.state='active'
           ORDER BY bs.created_at DESC LIMIT 1`,
        );
        return r.rows[0] ?? null;
      });
  if (orphan) {
    await withTenant(pool, ctx.tenantId, async (c) => {
      await c.query("UPDATE bot_sessions SET conversation_id=$2 WHERE id=$1", [orphan.id, hook.conversationId]);
    });
  }
  const sessionRow = active ?? orphan;
  const conversation = await resolveConversation(pool, ctx, hook.conversationId);
  if (sessionRow) {
    const bot = await loadPublishedBot(pool, ctx, sessionRow.bot_id as string);
    if (!bot) return;
    await advanceSession(
      pool,
      ctx,
      bot,
      sessionRow.id as string,
      {
        botId: sessionRow.bot_id as string,
        currentStep: sessionRow.current_step as number,
        variables: jsonObj(sessionRow.variables),
        state: sessionRow.state as "active" | "finished" | "failed",
        leadId: (sessionRow.lead_id as string | null) ?? hook.leadId,
        lastReply: hook.messageText,
        waitingStep: typeof sessionRow.waiting_step === "number" ? (sessionRow.waiting_step as number) : undefined,
      },
      hook.messageText,
      conversation,
      clients,
    ).catch(() => undefined);
    return;
  }
  // start published message_received bots
  const triggers = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `SELECT bt.bot_id, b.name, b.steps FROM bot_triggers bt JOIN bots b ON b.id=bt.bot_id
       WHERE bt.kind='message_received' AND bt.active=true AND b.status='published'
       ORDER BY b.version DESC LIMIT 3`,
    );
    return r.rows as Array<{ bot_id: string; name: string; steps: unknown[] }>;
  });
  for (const trigger of triggers) {
    const bot: DialogBot = { id: trigger.bot_id, name: trigger.name, status: "published", version: 0, steps: trigger.steps as DialogStep[] };
    await advanceSession(pool, ctx, bot, null, { botId: bot.id, currentStep: 0, variables: {}, state: "active", leadId: hook.leadId, lastReply: hook.messageText }, hook.messageText, conversation, clients).catch(() => undefined);
  }
}

export async function onStageChanged(pool: pg.Pool, ctx: RequestContext, hook: HookContext, clients: RuntimeClients): Promise<void> {
  const triggers = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `SELECT bt.bot_id, b.name, b.steps FROM bot_triggers bt JOIN bots b ON b.id=bt.bot_id
       WHERE bt.kind='stage_changed' AND bt.active=true AND b.status='published'
       ORDER BY b.version DESC LIMIT 5`,
    );
    return r.rows as Array<{ bot_id: string; name: string; steps: unknown[] }>;
  });
  for (const trigger of triggers) {
    const bot: DialogBot = { id: trigger.bot_id, name: trigger.name, status: "published", version: 0, steps: trigger.steps as DialogStep[] };
    const conversation = hook.conversationId ? await resolveConversation(pool, ctx, hook.conversationId) : null;
    await advanceSession(pool, ctx, bot, null, { botId: bot.id, currentStep: 0, variables: {}, state: "active", leadId: hook.leadId }, undefined, conversation, clients).catch(() => undefined);
  }
}

// ---------- simulate / launch ----------

export async function simulate(pool: pg.Pool, ctx: RequestContext, botId: string, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const bot = await loadPublishedBot(pool, ctx, botId)
    ?? await withTenant(pool, ctx.tenantId, async (c) => {
      const r = await c.query("SELECT id, name, status, version, steps FROM bots WHERE id=$1", [botId]);
      return r.rows[0] ? toBot(r.rows[0] as Record<string, unknown>) : null;
    });
  if (!bot) return { status: 404, body: { error: "bot_not_found" } };
  const replies = Array.isArray(body["replies"]) ? (body["replies"] as unknown[]).map(String) : [];
  let session: SessionState = { botId, currentStep: 0, variables: {}, state: "active", waitingStep: undefined };
  const transcript: Array<Record<string, unknown>> = [];
  let replyIdx = 0;
  for (let guard = 0; guard < 50; guard++) {
    // Feed the next fixture reply only while the bot is waiting on input;
    // otherwise the run starts and proceeds until it pauses or finishes.
    const reply = session.waitingStep !== undefined && replyIdx < replies.length ? replies[replyIdx++] : undefined;
    const outcome = runDialogOnce(bot, session, reply, {
      lead: { id: "sim-lead", name: "Sim", custom_fields: {}, tags: [] },
      contact: null,
      messageText: reply,
      botName: bot.name,
    });
    transcript.push({ sent: outcome.sent, actions: outcome.actions, step: outcome.session.currentStep });
    session = outcome.session;
    if (outcome.finished || outcome.error) break;
    if (reply === undefined && session.waitingStep === undefined) break;
    if (guard > 0 && reply === undefined && outcome.sent.length === 0) break;
  }
  return { status: 200, body: { transcript, final_state: session.state, variables: session.variables } };
}

export async function launch(pool: pg.Pool, ctx: RequestContext, botId: string, body: Record<string, unknown>, clients: RuntimeClients): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const bot = await loadPublishedBot(pool, ctx, botId);
  if (!bot) return { status: 404, body: { error: "bot_not_published" } };
  const leadId = asUuid(body["lead_id"]);
  const conversationId = asUuid(body["conversation_id"]);
  const conversation = conversationId ? await resolveConversation(pool, ctx, conversationId) : null;
  const sessionId = await persistSession(pool, ctx, bot.id, { botId: bot.id, currentStep: 0, variables: {}, state: "active", leadId: leadId ?? undefined }, null, conversation?.id ?? null);
  await advanceSession(pool, ctx, bot, sessionId, { botId: bot.id, currentStep: 0, variables: {}, state: "active", leadId: leadId ?? undefined, waitingStep: undefined }, undefined, conversation, clients);
  return { status: 201, body: { session_id: sessionId } };
}
