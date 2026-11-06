/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * AI agent HTTP surface (fake provider; real providers behind user keys):
 *   GET  /api/v1/ai/agents                  list agents
 *   POST /api/v1/ai/agents                  create agent (provider fake by default)
 *   POST /api/v1/ai/agents/:id/publish       draft -> published
 *   GET  /api/v1/ai/sources                 list knowledge sources
 *   POST /api/v1/ai/sources                 add text/url/file source (text ingested; url/file stubbed for fake mode)
 *   POST /api/v1/ai/copilot/summary          conversation summary (stateless)
 *   POST /api/v1/ai/copilot/rewrite          tone rewrite (stateless)
 *   POST /api/v1/ai/copilot/suggest-reply    reply suggestion w/ KB (stateless)
 *
 * Runtime: inbound webhook -> onAiMessage: the first PUBLISHED agent with a
 * message trigger handles the conversation; sessions persist; hand_off ends
 * the session and posts a team-internal note.
 */

import type pg from "pg";
import { withTenant } from "@knotwire/core";
import type { RequestContext } from "./context.js";
import { requireWriteRole } from "./context.js";
import type { HandlerResult } from "./routes-crm.js";
import { writeAudit } from "./audit.js";
import { encryptField, decryptField } from "./crypto.js";
import { FakeLlmClient, type LlmClient, type LlmMessage, type LlmResult } from "./llm.js";
import type { RuntimeClients } from "./routes-dialog.js";
import { recordMessage } from "./routes-inbox.js";

const asUuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

const text = (v: unknown, max = 2000): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const jsonArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function clientFor(provider: string): LlmClient {
  // OpenAI/Anthropic join here when a user-supplied key is configured.
  void provider;
  return new FakeLlmClient();
}

// ---------- agents CRUD ----------

export async function listAgents(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, name, status, provider, model, system_prompt, tools, created_at, updated_at FROM ai_agents ORDER BY name");
    return r.rows;
  });
  return { status: 200, body: { agents: rows } };
}

export async function createAgent(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 200);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const provider = text(body["provider"], 40) ?? "fake";
  const model = text(body["model"], 200);
  const apiKey = text(body["api_key"], 2000);
  const systemPrompt = text(body["system_prompt"], 4000) ?? "";
  const tools = jsonArr(body["tools"]).map(String).filter((t) => t.trim());
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO ai_agents (tenant_id, name, status, provider, model, api_key_enc, system_prompt, tools) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7) RETURNING id, name, status, provider, model, system_prompt, tools, created_at",
      [ctx.tenantId, name, provider, model, apiKey ? encryptField(apiKey) : null, systemPrompt, JSON.stringify(tools.length ? tools : ["lookup_product", "update_lead", "move_stage", "create_task", "hand_off"])],
    );
    await writeAudit(c, ctx, { entity: "ai_agent", entityId: r.rows[0].id, action: "created", after: { ...r.rows[0], api_key: "[redacted]" }, before: null });
    return r.rows[0] as Record<string, unknown>;
  });
  return { status: 201, body: row };
}

export async function publishAgent(pool: pg.Pool, ctx: RequestContext, agentId: string): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("UPDATE ai_agents SET status='published' WHERE id=$1 AND status='draft' RETURNING id, name, status", [agentId]);
    return r.rows[0] ?? null;
  });
  if (!row) return { status: 404, body: { error: "agent_not_found_or_not_draft" } };
  return { status: 200, body: row };
}

// ---------- sources ----------

export async function listSources(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, kind, title, left(content, 200) AS content_preview, source_url, created_at FROM ai_sources ORDER BY created_at DESC");
    return r.rows;
  });
  return { status: 200, body: { sources: rows } };
}

export async function addSource(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const title = text(body["title"], 300);
  if (!title) return { status: 400, body: { error: "title_required" } };
  const kind = text(body["kind"], 20) ?? "text";
  if (!["text", "url", "file"].includes(kind)) return { status: 400, body: { error: "invalid_kind" } };
  const content = text(body["content"], 20000) ?? "";
  const sourceUrl = text(body["source_url"], 1000);
  if (kind === "text" && !content) return { status: 400, body: { error: "content_required" } };
  if ((kind === "url" || kind === "file") && !content) {
    // Remote fetch lands with real ingestion in v1; fake mode keeps the title.
    return { status: 202, body: { queued: true, note: "url/file ingestion is stubbed in fake mode; provide kind=text for immediate use" } };
  }
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO ai_sources (tenant_id, kind, title, content, source_url) VALUES ($1,$2,$3,$4,$5) RETURNING id, kind, title, source_url, created_at",
      [ctx.tenantId, kind, title, content, sourceUrl],
    );
    return r.rows[0] as Record<string, unknown>;
  });
  return { status: 201, body: row };
}

// ---------- runtime ----------

export interface AiHook {
  conversationId: string;
  messageText?: string | undefined;
}

export async function onAiMessage(pool: pg.Pool, ctx: RequestContext, hook: AiHook, clients: RuntimeClients): Promise<void> {
  // first published agent wins (creation order)
  const agent = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, name, provider, model, system_prompt, tools FROM ai_agents WHERE status='published' ORDER BY created_at DESC LIMIT 1");
    return r.rows[0] ?? null;
  });
  if (!agent) return;

  const conversation = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, channel, external_id_enc FROM conversations WHERE id=$1", [hook.conversationId]);
    if (r.rowCount === 0) return null;
    return { id: r.rows[0].id as string, channel: r.rows[0].channel as string, waId: decryptField(r.rows[0].external_id_enc as string) };
  });
  if (!conversation) return;

  // existing active session?
  let session = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, state, history, turn_count FROM ai_sessions WHERE conversation_id=$1 AND state='active' ORDER BY created_at DESC LIMIT 1",
      [hook.conversationId],
    );
    return r.rows[0] ?? null;
  });
  if (!session) {
    const created = await withTenant(pool, ctx.tenantId, async (c) => {
      const r = await c.query(
        "INSERT INTO ai_sessions (tenant_id, agent_id, conversation_id, state, history) VALUES ($1,$2,$3,'active','[]') RETURNING id, state, history, turn_count",
        [ctx.tenantId, agent.id, hook.conversationId],
      );
      return r.rows[0];
    });
    session = created;
  }
  if (session.state === "handed_off" || session.state === "finished") return;

  const history = (Array.isArray(session.history) ? session.history : []) as Array<{ role: "user" | "assistant"; text: string }>;
  const knowledge = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT title, content FROM ai_sources ORDER BY created_at DESC LIMIT 50");
    return r.rows.map((s) => ({ title: s.title as string, content: s.content as string }));
  });

  const messages: LlmMessage[] = [
    { role: "system", text: String(agent.system_prompt ?? "") },
    ...history,
    { role: "user", text: hook.messageText ?? "" },
  ];
  const client = clientFor(String(agent.provider));
  const result = await client.complete({
    model: (agent.model as string | null) ?? undefined,
    system: String(agent.system_prompt ?? ""),
    messages,
    tools: (agent.tools as string[]) ?? [],
    knowledge,
  });

  // usage log
  await withTenant(pool, ctx.tenantId, async (c) => {
    await c.query(
      "INSERT INTO ai_usage (tenant_id, agent_id, provider, model, prompt_tokens, completion_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [ctx.tenantId, agent.id, String(agent.provider), String(agent.model ?? client.kind), result.usage.promptTokens, result.usage.completionTokens, result.usage.costUsd],
    );
  });

  const tool = result.turn.toolCalls[0];
  if (tool?.name === "hand_off") {
    await withTenant(pool, ctx.tenantId, async (c) => {
      await c.query("UPDATE ai_sessions SET state='handed_off' WHERE id=$1", [session.id]);
      await recordMessage(c, ctx, {
        conversationId: conversation.id,
        providerMessageId: null,
        direction: "outbound",
        type: "text",
        body: "[Internal] AI handed off: " + String(tool.args["reason"] ?? "no_reason"),
        deliveryStatus: "sent",
        isInternal: true,
        createdByUserId: ctx.userId,
      });
    });
    return;
  }
  if (tool?.name === "lookup_product") {
    const answer = result.turn.text || `Looking up "${String(tool.args["query"] ?? "")}" for you...`;
    await withTenant(pool, ctx.tenantId, async (c) =>
      recordMessage(c, ctx, { conversationId: conversation.id, providerMessageId: null, direction: "outbound", type: "text", body: answer, deliveryStatus: "sent" }),
    );
    return;
  }

  const reply = result.turn.text || "Thanks for your message!";
  await withTenant(pool, ctx.tenantId, async (c) =>
    recordMessage(c, ctx, { conversationId: conversation.id, providerMessageId: null, direction: "outbound", type: "text", body: reply, deliveryStatus: "sent" }),
  );
  await withTenant(pool, ctx.tenantId, async (c) => {
    const nextHistory = [
      ...history,
      { role: "user" as const, text: hook.messageText ?? "" },
      { role: "assistant" as const, text: reply },
    ].slice(-40);
    await c.query("UPDATE ai_sessions SET history=$2, turn_count=turn_count+1 WHERE id=$1", [session.id, JSON.stringify(nextHistory)]);
  });
  void clients;
}

// ---------- copilot (stateless) ----------

async function copilotComplete(pool: pg.Pool, ctx: RequestContext, system: string, userText: string): Promise<LlmResult> {
  const knowledge = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT title, content FROM ai_sources ORDER BY created_at DESC LIMIT 50");
    return r.rows.map((s) => ({ title: s.title as string, content: s.content as string }));
  });
  return new FakeLlmClient().complete({
    system,
    messages: [{ role: "system", text: system }, { role: "user", text: userText }],
    tools: [],
    knowledge,
  });
}

export async function copilotSummarize(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const conversationId = asUuid(body["conversation_id"]);
  if (!conversationId) return { status: 400, body: { error: "conversation_id_required" } };
  const messages = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT body FROM messages WHERE conversation_id=$1 AND is_internal=false ORDER BY sent_at ASC LIMIT 100",
      [conversationId],
    );
    return r.rows.map((m) => String(m.body ?? "")).join("\n");
  });
  const result = await copilotComplete(pool, ctx, "Summarize this sales conversation in 3 bullets: intent, open questions, next step.", messages);
  return { status: 200, body: { summary: result.turn.text } };
}

export async function copilotRewrite(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const textIn = text(body["text"], 4000);
  if (!textIn) return { status: 400, body: { error: "text_required" } };
  const tone = text(body["tone"], 40) ?? "friendly";
  const result = await copilotComplete(pool, ctx, `Rewrite in a ${tone} tone, keep the meaning. Done.`, textIn);
  return { status: 200, body: { rewritten: result.turn.text } };
}

export async function copilotSuggestReply(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const conversationId = asUuid(body["conversation_id"]);
  if (!conversationId) return { status: 400, body: { error: "conversation_id_required" } };
  const last = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT body FROM messages WHERE conversation_id=$1 AND direction='inbound' AND is_internal=false ORDER BY sent_at DESC LIMIT 5",
      [conversationId],
    );
    return r.rows.map((m) => String(m.body ?? "")).join("\n");
  });
  const result = await copilotComplete(pool, ctx, "Suggest one short, on-brand reply to the customer's last message.", last || "Suggest a greeting reply.");
  return { status: 200, body: { suggestion: result.turn.text } };
}
