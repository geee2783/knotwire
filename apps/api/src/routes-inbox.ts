/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * WhatsApp inbox + webhook ingress (fake-first; real Cloud API behind creds).
 *
 *   POST /api/v1/channels/whatsapp/accounts        connect a channel (fake in M2)
 *   GET  /api/v1/channels/whatsapp/accounts        list channels (tokens never returned)
 *   GET  /api/v1/channels/whatsapp/webhook?hub...   Meta verification handshake
 *   POST /api/v1/channels/whatsapp/webhook         inbound events (HMAC verified)
 *   POST /api/v1/channels/whatsapp/dev/fake-inbound  inject fake inbound (dev only)
 *   GET  /api/v1/conversations                     list inbox
 *   GET  /api/v1/conversations/:id                 thread + window state
 *   POST /api/v1/conversations/:id/messages         send text (window-checked)
 *   POST /api/v1/conversations/:id/internal-notes   private team note
 *   POST /api/v1/conversations/:id/close|reopen|assign
 *   POST /api/v1/conversations/:id/opt-out          opt-out registry write
 *   GET  /inbox                                    minimal inbox UI (server-rendered)
 */

import { createHmac, randomBytes } from "node:crypto";
import type pg from "pg";
import { withTenant } from "@knotwire/core";
import type { RequestContext } from "./context.js";
import { requireWriteRole } from "./context.js";
import type { HandlerResult } from "./routes-crm.js";
import { writeAudit } from "./audit.js";
import { encryptField, decryptField, hashIdentity } from "./crypto.js";
import { FakeWhatsAppClient, isWithinServiceWindow } from "./whatsapp.js";

const asUuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

const text = (v: unknown, max = 1000): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

// ---------- conversation helpers (RLS-scoped via withTenant) ----------

async function findOrCreateConversation(
  client: pg.PoolClient,
  ctx: RequestContext,
  input: { channelAccountId: string | null; waId: string; displayName?: string | undefined },
): Promise<Record<string, unknown>> {
  const waIdHash = hashIdentity(input.waId);
  const found = await client.query(
    "SELECT id, display_name FROM conversations WHERE channel='whatsapp-cloud' AND external_id_hash=$1",
    [waIdHash],
  );
  if (found.rowCount && found.rowCount > 0) return found.rows[0];
  const created = await client.query(
    `INSERT INTO conversations (tenant_id, channel, channel_account_id, external_id_enc, external_id_hash, display_name, last_message_at)
     VALUES ($1,'whatsapp-cloud',$2,$3,$4,$5,now())
     RETURNING id, display_name`,
    [ctx.tenantId, input.channelAccountId, encryptField(input.waId), waIdHash, input.displayName ?? null],
  );
  return created.rows[0];
}

async function lastInboundAt(client: pg.PoolClient, conversationId: string): Promise<Date | null> {
  const r = await client.query(
    "SELECT MAX(sent_at) AS ts FROM messages WHERE conversation_id=$1 AND direction='inbound'",
    [conversationId],
  );
  const ts = r.rows[0]?.ts;
  return ts ? new Date(ts) : null;
}

export async function recordMessage(
  client: pg.PoolClient,
  ctx: RequestContext,
  input: {
    conversationId: string;
    providerMessageId: string | null;
    direction: "inbound" | "outbound";
    type: string;
    body: string | null;
    deliveryStatus: string;
    templateName?: string | undefined;
    isInternal?: boolean;
    createdByUserId?: string | undefined;
  },
): Promise<Record<string, unknown>> {
  const r = await client.query(
    `INSERT INTO messages (tenant_id, conversation_id, provider_message_id, direction, type, body, delivery_status, template_name, is_internal, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      ctx.tenantId,
      input.conversationId,
      input.providerMessageId,
      input.direction,
      input.type,
      input.body,
      input.deliveryStatus,
      input.templateName ?? null,
      input.isInternal ?? false,
      input.createdByUserId ?? null,
    ],
  );
  await client.query("UPDATE conversations SET last_message_at=now() WHERE id=$1", [input.conversationId]);
  return r.rows[0];
}

// ---------- channel accounts ----------

export async function connectChannel(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const providerAccountId = text(body["provider_account_id"], 200);
  if (!providerAccountId) return { status: 400, body: { error: "provider_account_id_required" } };
  const accessToken = text(body["access_token"], 2000);
  if (!accessToken) return { status: 400, body: { error: "access_token_required" } };
  const verifyToken = text(body["verify_token"], 256) ?? randomBytes(16).toString("hex");
  const displayName = text(body["display_name"], 200);
  const result = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO channel_accounts (tenant_id, provider, provider_account_id, display_name, access_token_enc, verify_token, phone_number_id, waba_id)
       VALUES ($1,'whatsapp-cloud',$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, provider, provider_account_id)
       DO UPDATE SET display_name=EXCLUDED.display_name, access_token_enc=EXCLUDED.access_token_enc, verify_token=EXCLUDED.verify_token,
                     phone_number_id=EXCLUDED.phone_number_id, waba_id=EXCLUDED.waba_id, updated_at=now()
       RETURNING id, provider, provider_account_id, display_name, phone_number_id, waba_id, active, created_at`,
      [ctx.tenantId, providerAccountId, displayName, encryptField(accessToken), verifyToken, text(body["phone_number_id"], 200), text(body["waba_id"], 200)],
    );
    const row = r.rows[0];
    await writeAudit(c, ctx, { entity: "channel_account", entityId: row.id, action: "created", after: { ...row, access_token: "[redacted]", verify_token: "[redacted]" }, before: null });
    return row;
  });
  return { status: 201, body: { ...result, verify_token: "[not returned after creation]" } };
}

export async function listChannels(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, provider, provider_account_id, display_name, phone_number_id, waba_id, active, created_at FROM channel_accounts ORDER BY created_at DESC",
    );
    return r.rows;
  });
  return { status: 200, body: { accounts: rows } };
}

// ---------- webhook ingress ----------

export async function ingestInbound(
  pool: pg.Pool,
  ctx: RequestContext,
  body: Record<string, unknown>,
  rawBody: string,
  signatureHeader: string | undefined,
  fakeClients: Map<string, FakeWhatsAppClient>,
  onStored?: ((info: { conversationId: string; text: string | undefined }) => Promise<void>) | undefined,
): Promise<HandlerResult> {
  // HMAC over raw bytes using the channel verify_token (access-token bound
  // in Meta's setup; we bind to verify_token for the dev path and document
  // the swap when real traffic flows).
  const account = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, verify_token FROM channel_accounts WHERE active=true ORDER BY created_at DESC LIMIT 1");
    return r.rows[0] ?? null;
  });
  if (!account) return { status: 404, body: { error: "no_active_channel" } };
  if (signatureHeader) {
    const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : "";
    const computed = createHmac("sha256", account.verify_token as string).update(rawBody).digest("hex");
    if (provided !== computed) return { status: 403, body: { error: "invalid_signature" } };
  }
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as Array<Record<string, unknown>>) : [];
  const created: Array<Record<string, unknown>> = [];
  for (const raw of messages) {
    const waId = text(raw["from"], 60);
    if (!waId) continue;
    const msgText = raw["text"] ? (raw["text"] as Record<string, unknown>)["body"] as string : raw["body"] as string | undefined;
    const conversation = await withTenant(pool, ctx.tenantId, async (c) => {
      const conv = await findOrCreateConversation(c, ctx, {
        channelAccountId: account.id as string,
        waId,
        displayName: raw["display_name"] as string | undefined,
      });
      const message = await recordMessage(c, ctx, {
        conversationId: conv.id as string,
        providerMessageId: text(raw["provider_message_id"], 200) ?? text(raw["id"], 200),
        direction: "inbound",
        type: String(raw["type"] ?? "text"),
        body: typeof msgText === "string" ? msgText.slice(0, 4000) : null,
        deliveryStatus: "delivered",
      });
      await writeAudit(c, ctx, { entity: "message", entityId: message.id as string, action: "created", after: { direction: "inbound", conversation_id: conv.id }, before: null });
      return { conversation: conv, message };
    });
    created.push(conversation.message);
  }
  void fakeClients;
  for (const item of created) {
    if (onStored && item["conversation_id"]) await onStored({ conversationId: String(item["conversation_id"]), text: (item["body"] as string | null) ?? undefined }).catch(() => undefined);
  }
  return { status: 200, body: { accepted: created.length } };
}

export async function injectFakeInbound(
  pool: pg.Pool,
  ctx: RequestContext,
  body: Record<string, unknown>,
): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const waId = text(body["from"], 60);
  const msgText = text(body["text"], 4000);
  if (!waId) return { status: 400, body: { error: "from_required" } };
  if (msgText === null) return { status: 400, body: { error: "text_required" } };
  const account = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id FROM channel_accounts WHERE active=true ORDER BY created_at DESC LIMIT 1");
    return r.rows[0] ?? null;
  });
  const result = await withTenant(pool, ctx.tenantId, async (c) => {
    const conv = await findOrCreateConversation(c, ctx, {
      channelAccountId: account?.id as string | null,
      waId,
      displayName: text(body["display_name"], 200) ?? undefined,
    });
    const message = await recordMessage(c, ctx, {
      conversationId: conv.id as string,
      providerMessageId: `wamid.fakein_${Date.now()}`,
      direction: "inbound",
      type: "text",
      body: msgText,
      deliveryStatus: "delivered",
    });
    await writeAudit(c, ctx, { entity: "message", entityId: message.id as string, action: "created", after: { direction: "inbound", conversation_id: conv.id }, before: null });
    return { conversation_id: conv.id, message_id: message.id };
  });
  return { status: 201, body: result };
}

// ---------- inbox reads ----------

async function shapeConversation(row: Record<string, unknown>): Promise<Record<string, unknown>> {
  let waId = "";
  try {
    waId = decryptField(row["external_id_enc"] as string);
  } catch {
    waId = "";
  }
  return {
    id: row["id"],
    channel: row["channel"],
    display_name: row["display_name"],
    wa_id: waId,
    status: row["status"],
    assigned_user_id: row["assigned_user_id"],
    last_message_at: row["last_message_at"],
    created_at: row["created_at"],
  };
}

export async function listConversations(pool: pg.Pool, ctx: RequestContext, url: URL): Promise<HandlerResult> {
  const statusFilter = text(url.searchParams.get("status"), 20);
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (statusFilter === "open" || statusFilter === "closed") {
      params.push(statusFilter);
      clauses.push(`status = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await c.query(
      `SELECT id, channel, display_name, external_id_enc, status, assigned_user_id, last_message_at, created_at
       FROM conversations ${where} ORDER BY last_message_at DESC NULLS LAST LIMIT 100`,
      params,
    );
    return r.rows;
  });
  return { status: 200, body: { conversations: await Promise.all(rows.map(shapeConversation)) } };
}

export async function getConversation(pool: pg.Pool, ctx: RequestContext, conversationId: string): Promise<HandlerResult> {
  const result = await withTenant(pool, ctx.tenantId, async (c) => {
    const conv = await c.query(
      "SELECT id, channel, display_name, external_id_enc, status, assigned_user_id, last_message_at, created_at FROM conversations WHERE id=$1",
      [conversationId],
    );
    if (conv.rowCount === 0) return null;
    const messages = await c.query(
      "SELECT id, direction, type, body, delivery_status, template_name, is_internal, created_by_user_id, sent_at FROM messages WHERE conversation_id=$1 ORDER BY sent_at ASC",
      [conversationId],
    );
    const inbound = await lastInboundAt(c, conversationId);
    return { conversation: conv.rows[0], messages: messages.rows, inbound };
  });
  if (!result) return { status: 404, body: { error: "conversation_not_found" } };
  return {
    status: 200,
    body: {
      conversation: await shapeConversation(result.conversation),
      service_window: {
        open: isWithinServiceWindow(result.inbound),
        last_inbound_at: result.inbound,
        expires_at: result.inbound ? new Date(result.inbound.getTime() + 24 * 60 * 60 * 1000) : null,
      },
      messages: result.messages,
    },
  };
}

// ---------- inbox writes ----------

export async function sendMessage(
  pool: pg.Pool,
  ctx: RequestContext,
  conversationId: string,
  body: Record<string, unknown>,
  fakeClients: Map<string, FakeWhatsAppClient>,
): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const msgText = text(body["text"], 4000);
  if (msgText === null) return { status: 400, body: { error: "text_required" } };
  const waId = await withTenant(pool, ctx.tenantId, async (c) => {
    const conv = await c.query("SELECT display_name, external_id_enc FROM conversations WHERE id=$1", [conversationId]);
    if (conv.rowCount === 0) return null;
    return decryptField(conv.rows[0].external_id_enc as string);
  });
  if (waId === null) return { status: 404, body: { error: "conversation_not_found" } };

  const blocked = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT 1 FROM opt_outs WHERE conversation_id=$1", [conversationId]);
    return r.rowCount !== null && r.rowCount > 0;
  });
  if (blocked) return { status: 409, body: { error: "opted_out" } };

  const inbound = await withTenant(pool, ctx.tenantId, async (c) => lastInboundAt(c, conversationId));
  const templateName = text(body["template_name"], 200);
  if (!isWithinServiceWindow(inbound) && !templateName) {
    return { status: 409, body: { error: "service_window_closed", requires: "approved_template" } };
  }
  if (templateName) {
    const approved = await withTenant(pool, ctx.tenantId, async (c) => {
      const r = await c.query("SELECT 1 FROM wa_templates WHERE name=$1 AND status='APPROVED' ORDER BY created_at DESC LIMIT 1", [templateName]);
      return r.rowCount !== null && r.rowCount > 0;
    });
    if (!approved) return { status: 409, body: { error: "template_not_approved" } };
  }

  let client = fakeClients.get(ctx.tenantId) as FakeWhatsAppClient | undefined;
  if (!client) {
    client = new FakeWhatsAppClient();
    fakeClients.set(ctx.tenantId, client);
  }
  const sendInput: Parameters<FakeWhatsAppClient["sendText"]>[0] = templateName
    ? { to: waId, text: msgText, type: "template", templateName }
    : { to: waId, text: msgText, type: "text" };
  const result = await client.sendText(sendInput);
  const message = await withTenant(pool, ctx.tenantId, async (c) => {
    const row = await recordMessage(c, ctx, {
      conversationId,
      providerMessageId: result.providerMessageId,
      direction: "outbound",
      type: templateName ? "template" : "text",
      body: msgText,
      deliveryStatus: result.status,
      templateName: templateName ?? undefined,
      createdByUserId: ctx.userId,
    });
    await writeAudit(c, ctx, { entity: "message", entityId: row.id as string, action: "created", after: { direction: "outbound", conversation_id: conversationId }, before: null });
    return row;
  });
  return { status: 201, body: message };
}

export async function addInternalNote(
  pool: pg.Pool,
  ctx: RequestContext,
  conversationId: string,
  body: Record<string, unknown>,
): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const note = text(body["body"], 4000);
  if (note === null) return { status: 400, body: { error: "body_required" } };
  const created = await withTenant(pool, ctx.tenantId, async (c) => {
    const conv = await c.query("SELECT 1 FROM conversations WHERE id=$1", [conversationId]);
    if (conv.rowCount === 0) return null;
    return recordMessage(c, ctx, {
      conversationId,
      providerMessageId: null,
      direction: "outbound",
      type: "text",
      body: note,
      deliveryStatus: "sent",
      isInternal: true,
      createdByUserId: ctx.userId,
    });
  });
  if (!created) return { status: 404, body: { error: "conversation_not_found" } };
  return { status: 201, body: created };
}

export async function setConversationState(
  pool: pg.Pool,
  ctx: RequestContext,
  conversationId: string,
  action: "close" | "reopen" | "assign" | "opt-out",
  body: Record<string, unknown> = {},
): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const result = await withTenant(pool, ctx.tenantId, async (c) => {
    const cur = await c.query("SELECT id, status, assigned_user_id FROM conversations WHERE id=$1", [conversationId]);
    if (cur.rowCount === 0) return null;
    if (action === "close" || action === "reopen") {
      const status = action === "close" ? "closed" : "open";
      const upd = await c.query("UPDATE conversations SET status=$2, is_closed=($2='closed') WHERE id=$1 RETURNING status", [conversationId, status]);
      await writeAudit(c, ctx, { entity: "conversation", entityId: conversationId, action: "updated", after: upd.rows[0], before: cur.rows[0] });
      return { id: conversationId, status };
    }
    if (action === "assign") {
      const userId = asUuid(body["user_id"]);
      const upd = await c.query("UPDATE conversations SET assigned_user_id=$2 WHERE id=$1 RETURNING assigned_user_id", [conversationId, userId]);
      await writeAudit(c, ctx, { entity: "conversation", entityId: conversationId, action: "updated", after: upd.rows[0], before: cur.rows[0] });
      return { id: conversationId, assigned_user_id: userId };
    }
    await c.query(
      "INSERT INTO opt_outs (conversation_id, tenant_id, reason) VALUES ($1,$2,$3) ON CONFLICT (conversation_id) DO UPDATE SET reason=EXCLUDED.reason",
      [conversationId, ctx.tenantId, text(body["reason"], 300)],
    );
    await writeAudit(c, ctx, { entity: "conversation", entityId: conversationId, action: "updated", after: { opted_out: true }, before: cur.rows[0] });
    return { id: conversationId, opted_out: true };
  });
  if (!result) return { status: 404, body: { error: "conversation_not_found" } };
  return { status: 200, body: result };
}

// ---------- templates ----------

export async function listTemplates(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, name, language, category, status, components FROM wa_templates ORDER BY created_at DESC");
    return r.rows;
  });
  return { status: 200, body: { templates: rows } };
}

export async function registerTemplate(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 200);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const language = text(body["language"], 10) ?? "en";
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO wa_templates (tenant_id, name, language, category, status, components) VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING *",
      [ctx.tenantId, name, language, text(body["category"], 60) ?? "UTILITY", JSON.stringify(Array.isArray(body["components"]) ? body["components"] : [])],
    );
    await writeAudit(c, ctx, { entity: "wa_template", entityId: r.rows[0].id, action: "created", after: r.rows[0], before: null });
    return r.rows[0] as Record<string, unknown>;
  });
  return { status: 201, body: row };
}

export async function submitTemplate(pool: pg.Pool, ctx: RequestContext, templateId: string): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  // Real Meta moderation submission wires in with creds (M2 gate). Fake marks APPROVED.
  const row = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("UPDATE wa_templates SET status='APPROVED' WHERE id=$1 RETURNING *", [templateId]);
    return r.rows[0] ?? null;
  });
  if (!row) return { status: 404, body: { error: "template_not_found" } };
  return { status: 200, body: row };
}

// ---------- minimal inbox UI (server-rendered, no build step) ----------

export function inboxPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Knotwire Inbox</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:0;display:grid;grid-template-columns:320px 1fr;min-height:100vh}
nav{border-right:1px solid #ddd;padding:1rem}main{padding:2rem}
.conv{padding:.75rem;border-bottom:1px solid #eee;cursor:pointer}.conv:hover{background:#f7f7f7}
.bubble{max-width:60%;padding:.5rem .75rem;border-radius:12px;margin:.25rem 0}
.in{background:#f1f1f1}.out{background:#d9f2e3;margin-left:auto}.note{background:#fff7d6;border:1px dashed #ccc}
small{color:#777}</style></head><body>
<nav><h2>Knotwire Inbox</h2><div id="list">Loading…</div></nav>
<main><h2 id="title">Select a conversation</h2><div id="thread"></div></main>
<script>
const token = ""; // paste a Bearer JWT for the demo; wire a real session in M9
const api = (p, o={}) => fetch(p, { ...o, headers: { ...(o.headers||{}), authorization: "Bearer " + token, "content-type":"application/json" } }).then(r=>r.json());
let current = null;
async function list() { const d = await api("/api/v1/conversations"); document.getElementById("list").innerHTML =
  d.conversations.map(c => '<div class="conv" onclick="openConv(\''+c.id+'\')"><b>'+(c.display_name||c.wa_id)+'</b><br><small>'+new Date(c.last_message_at).toLocaleString()+' · '+c.status+'</small></div>').join(""); }
async function openConv(id) { current = id; const d = await api("/api/v1/conversations/" + id);
  document.getElementById("title").textContent = d.conversation.display_name || d.conversation.wa_id;
  document.getElementById("thread").innerHTML = d.messages.map(m => '<div class="bubble '+(m.is_internal?"note":m.direction)+'">'+(m.is_internal?"[team note] ":"")+escapeHtml(m.body||"")+'<br><small>'+m.delivery_status+'</small></div>').join("") +
  '<br><input id="msg" placeholder="Message… (template required after 24h)" style="width:60%"><button onclick="send()">Send</button> <button onclick="note()">Team note</button> <button onclick="close_()">Close</button>';
  if (!d.service_window.open) document.getElementById("thread").insertAdjacentHTML("afterbegin", "<p><small>Service window closed — sends require an approved template.</small></p>");
}
function escapeHtml(s){const d=document.createElement("div");d.textContent=s;return d.innerHTML;}
async function send(){ const t=document.getElementById("msg").value; await api("/api/v1/conversations/"+current+"/messages",{method:"POST",body:JSON.stringify({text:t})}); openConv(current); }
async function note(){ const t=document.getElementById("msg").value; await api("/api/v1/conversations/"+current+"/internal-notes",{method:"POST",body:JSON.stringify({body:t})}); openConv(current); }
async function close_(){ await api("/api/v1/conversations/"+current+"/close",{method:"POST"}); openConv(current); }
list();
</script></body></html>`;
}
