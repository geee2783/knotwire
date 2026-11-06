/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * Facebook surfaces (fake-first):
 *   POST /api/v1/channels/facebook/accounts        connect a Messenger page
 *   GET  /api/v1/channels/facebook/webhook         Meta hub challenge (app_secret exchange)
 *   POST /api/v1/channels/facebook/webhook         page events: messages, postbacks, referrals
 *   POST /api/v1/channels/facebook/lead-forms/webhook  leadgen events -> incoming leads
 *   GET  /api/v1/attribution?ref=...               v1 per-ref stats (conversations + leads)
 *
 * Send path reuses the inbox routes with channel='facebook-messenger' and the
 * 24h window from facebook.ts. Messages to a PSID go out via the per-tenant
 * FakeMessengerClient held in the server's fake-clients map.
 */

import { createHmac, randomBytes } from "node:crypto";
import type pg from "pg";
import { withTenant } from "@knotwire/core";
import type { RequestContext } from "./context.js";
import { requireWriteRole } from "./context.js";
import type { HandlerResult } from "./routes-crm.js";
import { writeAudit } from "./audit.js";
import { encryptField, decryptField, hashIdentity } from "./crypto.js";
import { parseMeRef, FakeMessengerClient } from "./facebook.js";

const asUuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

const text = (v: unknown, max = 1000): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const sha256 = (s: string): string => createHmac("sha256", s).digest("hex");

// ---------- conversation helpers (mirror routes-inbox, channel-parameterized) ----------

async function findOrCreateConversation(
  client: pg.PoolClient,
  ctx: RequestContext,
  input: { channelAccountId: string | null; psid: string; displayName?: string | undefined; ref?: string | undefined; kind?: string | undefined; url?: string | undefined },
): Promise<Record<string, unknown>> {
  const psidHash = hashIdentity(input.psid);
  const found = await client.query(
    "SELECT id, display_name FROM conversations WHERE channel='facebook-messenger' AND external_id_hash=$1",
    [psidHash],
  );
  if (found.rowCount && found.rowCount > 0) return found.rows[0];
  const created = await client.query(
    `INSERT INTO conversations (tenant_id, channel, channel_account_id, external_id_enc, external_id_hash, display_name, source_ref, source_kind, source_url, last_message_at)
     VALUES ($1,'facebook-messenger',$2,$3,$4,$5,$6,$7,$8,now())
     RETURNING id, display_name`,
    [
      ctx.tenantId,
      input.channelAccountId,
      encryptField(input.psid),
      psidHash,
      input.displayName ?? null,
      input.ref ? parseMeRef(input.ref).ref : null,
      input.kind ?? null,
      input.url ?? null,
    ],
  );
  return created.rows[0];
}

async function recordMessage(
  client: pg.PoolClient,
  ctx: RequestContext,
  input: { conversationId: string; providerMessageId: string | null; type: string; body: string | null },
): Promise<Record<string, unknown>> {
  const r = await client.query(
    `INSERT INTO messages (tenant_id, conversation_id, provider_message_id, direction, type, body, delivery_status)
     VALUES ($1,$2,$3,'inbound',$4,$5,'delivered') RETURNING *`,
    [ctx.tenantId, input.conversationId, input.providerMessageId, input.type, input.body],
  );
  await client.query("UPDATE conversations SET last_message_at=now() WHERE id=$1", [input.conversationId]);
  return r.rows[0];
}

// ---------- messenger account ----------

export async function connectMessenger(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const pageId = text(body["page_id"], 200);
  if (!pageId) return { status: 400, body: { error: "page_id_required" } };
  const accessToken = text(body["page_access_token"], 2000);
  if (!accessToken) return { status: 400, body: { error: "page_access_token_required" } };
  const verifyToken = text(body["verify_token"], 256) ?? randomBytes(16).toString("hex");
  const displayName = text(body["display_name"], 200);
  const result = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO channel_accounts (tenant_id, provider, provider_account_id, display_name, access_token_enc, verify_token)
       VALUES ($1,'facebook-messenger',$2,$3,$4,$5)
       ON CONFLICT (tenant_id, provider, provider_account_id)
       DO UPDATE SET display_name=EXCLUDED.display_name, access_token_enc=EXCLUDED.access_token_enc, verify_token=EXCLUDED.verify_token, updated_at=now()
       RETURNING id, provider, provider_account_id, display_name, active, created_at`,
      [ctx.tenantId, pageId, displayName, encryptField(accessToken), verifyToken],
    );
    const row = r.rows[0];
    await writeAudit(c, ctx, { entity: "channel_account", entityId: row.id, action: "created", after: { ...row, access_token: "[redacted]" }, before: null });
    return row;
  });
  return { status: 201, body: result };
}

// ---------- messenger webhook ----------

export async function ingestMessengerWebhook(
  pool: pg.Pool,
  ctx: RequestContext,
  body: Record<string, unknown>,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<HandlerResult> {
  const account = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, verify_token FROM channel_accounts WHERE provider='facebook-messenger' AND active=true ORDER BY created_at DESC LIMIT 1");
    return r.rows[0] ?? null;
  });
  if (!account) return { status: 404, body: { error: "no_active_channel" } };
  if (signatureHeader) {
    const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : "";
    const computed = createHmac("sha256", account.verify_token as string).update(rawBody).digest("hex");
    if (provided !== computed) return { status: 403, body: { error: "invalid_signature" } };
  }
  const entries = Array.isArray(body["entry"]) ? (body["entry"] as Array<Record<string, unknown>>) : [];
  let accepted = 0;
  for (const entry of entries) {
    const messaging = Array.isArray(entry["messaging"]) ? (entry["messaging"] as Array<Record<string, unknown>>) : [];
    for (const event of messaging) {
      const sender = (event["sender"] as Record<string, unknown> | undefined)?.["id"];
      const psid = typeof sender === "string" ? sender : null;
      if (!psid) continue;
      // referral (m.me ref) rides on the first message or on postback.referral
      const referral = (event["postback"] as Record<string, unknown> | undefined)?.["referral"] as Record<string, unknown> | undefined;
      const ref = typeof referral?.["ref"] === "string" ? (referral["ref"] as string) : undefined;
      const parsed = parseMeRef(ref);
      const msg = event["message"] as Record<string, unknown> | undefined;
      const bodyText = msg ? String(msg["text"] ?? "") : undefined;
      const providerId = msg ? String(msg["mid"] ?? "") : undefined;
      const result = await withTenant(pool, ctx.tenantId, async (c) => {
        const conv = await findOrCreateConversation(c, ctx, {
          channelAccountId: account.id as string,
          psid,
          ref,
          kind: ref ? parsed.kind : undefined,
          url: typeof referral?.["source_url"] === "string" ? (referral["source_url"] as string) : undefined,
        });
        const message = await recordMessage(c, ctx, {
          conversationId: conv.id as string,
          providerMessageId: providerId ?? null,
          type: msg ? "text" : "postback",
          body: bodyText ?? (event["postback"] ? `[postback ${String((event["postback"] as Record<string, unknown>)["payload"] ?? "")}]` : null),
        });
        await writeAudit(c, ctx, { entity: "message", entityId: message.id as string, action: "created", after: { direction: "inbound", conversation_id: conv.id }, before: null });
        return message;
      });
      void result;
      accepted += 1;
    }
  }
  return { status: 200, body: { accepted } };
}

// ---------- lead forms ----------

export async function ingestLeadgenWebhook(
  pool: pg.Pool,
  ctx: RequestContext,
  body: Record<string, unknown>,
  rawBody: string,
  signatureHeader: string | undefined,
): Promise<HandlerResult> {
  const account = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, verify_token FROM channel_accounts WHERE provider='facebook-messenger' AND active=true ORDER BY created_at DESC LIMIT 1");
    return r.rows[0] ?? null;
  });
  if (!account) return { status: 404, body: { error: "no_active_channel" } };
  if (signatureHeader) {
    const provided = signatureHeader.startsWith("sha256=") ? signatureHeader.slice(7) : "";
    const computed = createHmac("sha256", account.verify_token as string).update(rawBody).digest("hex");
    if (provided !== computed) return { status: 403, body: { error: "invalid_signature" } };
  }
  // Meta's leadgen payload: {entry:[{changes:[{value:{leadgen_id, page_id, form_id, field_data...}}]}]}
  const entries = Array.isArray(body["entry"]) ? (body["entry"] as Array<Record<string, unknown>>) : [];
  let created = 0;
  for (const entry of entries) {
    const changes = Array.isArray(entry["changes"]) ? (entry["changes"] as Array<Record<string, unknown>>) : [];
    for (const change of changes) {
      const value = (change["value"] as Record<string, unknown>) ?? {};
      const leadgenId = text(value["leadgen_id"], 200) ?? `leadgen_${Date.now()}`;
      const fieldData = Array.isArray(value["field_data"]) ? (value["field_data"] as Array<Record<string, unknown>>) : [];
      const fields: Record<string, string> = {};
      for (const f of fieldData) {
        const name = text(f["name"], 100);
        const values = Array.isArray(f["values"]) ? (f["values"] as unknown[]) : [];
        if (name) fields[name] = String(values[0] ?? "");
      }
      const name = fields["name"] ?? fields["full_name"] ?? fields["email"] ?? `${leadgenId}`;
      const email = fields["email"] ?? null;
      const phone = fields["phone_number"] ?? fields["phone"] ?? null;
      const lead = await withTenant(pool, ctx.tenantId, async (c) => {
        const r = await c.query(
          `INSERT INTO leads (tenant_id, name, custom_fields, tags, incoming, source_kind, source_ref)
           VALUES ($1,$2,$3,$4,true,$5,$6) RETURNING *`,
          [
            ctx.tenantId,
            name.slice(0, 300),
            JSON.stringify({ leadgen_id: leadgenId, form_id: text(value["form_id"], 200), email, phone, ...fields }),
            ["facebook-lead-ad"],
            "facebook-lead-ad",
            text(value["form_id"], 200),
          ],
        );
        const row = r.rows[0];
        await writeAudit(c, ctx, { entity: "incoming_lead", entityId: row.id, action: "created", after: row, before: null });
        return row;
      });
      void lead;
      created += 1;
    }
  }
  return { status: 200, body: { created } };
}

// ---------- attribution ----------

export async function attributionStats(pool: pg.Pool, ctx: RequestContext, url: URL): Promise<HandlerResult> {
  const ref = text(url.searchParams.get("ref"), 200);
  const stats = await withTenant(pool, ctx.tenantId, async (c) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (ref) {
      params.push(ref);
      clauses.push("source_ref = $1");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const conv = await c.query(`SELECT count(*)::int AS n FROM conversations ${where}`, params);
    const leads = await c.query(`SELECT count(*)::int AS n FROM leads ${where}`, params);
    const byKind = await c.query(
      `SELECT source_kind AS kind, count(*)::int AS n FROM conversations ${where} GROUP BY source_kind ORDER BY n DESC`,
      params,
    );
    return { conversations: conv.rows[0].n, leads: leads.rows[0].n, kinds: byKind.rows };
  });
  return { status: 200, body: { ref: ref ?? null, ...stats } };
}
