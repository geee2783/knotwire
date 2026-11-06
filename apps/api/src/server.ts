/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * HTTP router. Public surface: /healthz, /readyz, /api/v1/*.
 * Auth: Authorization: Bearer <JWT> (claims: sub=userId, tenantId, role).
 */

import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import {
  connect,
  applyMigrations,
  type Pool,
} from "@knotwire/core";
import {
  authenticate,
  readJson,
  readBody,
  sendJson,
  sendError,
} from "./context.js";
import {
  listPipelines,
  createPipeline,
  createStage,
  updateStage,
  listLeads,
  createLead,
  getLead,
  updateLead,
  deleteLead,
  createIncomingLead,
  decideIncomingLead,
} from "./routes-crm.js";
import {
  listContacts,
  createContact,
  listCompanies,
  createCompany,
  listTasks,
  createTask,
  updateTask,
  listNotes,
  createNote,
  listTags,
  webhookCatalog,
  listWebhooks,
  createWebhook,
  deleteWebhook,
  testWebhook,
  exportLeadsCsv,
  importLeadsCsv,
} from "./routes-misc.js";
import { KNOTWIRE_OPENAPI } from "./openapi.js";
import {
  connectChannel,
  listChannels,
  ingestInbound,
  injectFakeInbound,
  listConversations,
  getConversation,
  sendMessage,
  addInternalNote,
  setConversationState,
  listTemplates,
  registerTemplate,
  submitTemplate,
  inboxPage,
} from "./routes-inbox.js";
import {
  connectMessenger,
  ingestMessengerWebhook,
  ingestLeadgenWebhook,
  attributionStats,
} from "./routes-fb.js";
import {
  listDialogs,
  createDialog,
  getDialog,
  updateDialog,
  publishDialog,
  listTriggers,
  addTrigger,
  listSessions,
  simulate,
  launch,
  onLeadCreated,
  onInboundMessage,
  onStageChanged,
  type RuntimeClients,
} from "./routes-dialog.js";
import {
  listAgents,
  createAgent,
  publishAgent,
  listSources,
  addSource,
  onAiMessage,
  copilotSummarize,
  copilotRewrite,
  copilotSuggestReply,
} from "./routes-ai.js";
import type { FakeWhatsAppClient } from "./whatsapp.js";
import type { FakeMessengerClient } from "./facebook.js";

export const VERSION = "0.2.0";

export interface ApiOptions {
  databaseUrl?: string | null | undefined;
  jwtSecret?: string | undefined;
  startWebhookWorker?: boolean | undefined;
}

export interface ApiHandle {
  server: Server;
  pool: Pool | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApi(options: ApiOptions = {}): ApiHandle {
  const databaseUrl = options.databaseUrl === undefined
    ? process.env["DATABASE_URL"]
    : (options.databaseUrl || undefined);
  const isProduction = process.env["NODE_ENV"] === "production";
  const jwtSecret =
    options.jwtSecret ??
    process.env["KNOTWIRE_JWT_SECRET"] ??
    (isProduction ? undefined : "dev-only-secret-change-me");
  if (!jwtSecret) {
    throw new Error("KNOTWIRE_JWT_SECRET must be set in production");
  }
  if (isProduction && jwtSecret === "dev-only-secret-change-me") {
    throw new Error("refusing to run production with the development secret");
  }
  const pool = databaseUrl ? connect(databaseUrl) : null;
  const startWorker = options.startWebhookWorker ?? false;
  // Per-tenant fake provider clients (real Meta providers replace these once
  // credentials are configured — M2/M3 gates). Runtime dialogs share the maps
  // so transcripts flow through the same fakes.
  const fakeWhatsAppClients = new Map<string, FakeWhatsAppClient>();
  const fakeMessengerClients = new Map<string, FakeMessengerClient>();
  const runtimeClients: RuntimeClients = { whatsapp: fakeWhatsAppClients, messenger: fakeMessengerClients };

  const handler = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && path === "/healthz") {
        sendJson(res, 200, { status: "ok", service: "knotwire-api", version: VERSION });
        return;
      }
      if (method === "GET" && path === "/readyz") {
        if (!pool) {
          sendJson(res, 503, { status: "degraded", reason: "DATABASE_URL not set" });
          return;
        }
        await pool.query("SELECT 1");
        sendJson(res, 200, { status: "ready", database: "ok" });
        return;
      }

      // Minimal inbox UI (server-rendered; no auth required to load the page,
      // the page's fetches are authenticated).
      if (method === "GET" && path === "/inbox") {
        const html = inboxPage();
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }

      if (!path.startsWith("/api/v1/")) {
        sendError(res, 404, "not_found");
        return;
      }

      // OpenAPI doc is public by design (self-host operators inspect their own instance).
      if (method === "GET" && path === "/api/v1/openapi.json") {
        sendJson(res, 200, KNOTWIRE_OPENAPI);
        return;
      }

      const ctx = authenticate(req, jwtSecret);
      if (!ctx) {
        sendError(res, 401, "unauthorized", "missing or invalid Bearer token");
        return;
      }

      if (!pool) {
        sendJson(res, 503, { error: "database_unavailable" });
        return;
      }

      const finish = async (result: Promise<{ status: number; body: unknown }>): Promise<void> => {
        const { status, body } = await result;
        sendJson(res, status, body);
      };

      // pipelines & stages
      if (method === "GET" && path === "/api/v1/pipelines") return finish(listPipelines(pool, ctx));
      if (method === "POST" && path === "/api/v1/pipelines") return finish(createPipeline(pool, ctx, await readJson(req)));
      {
        const m = /^\/api\/v1\/pipelines\/([^/]+)\/stages$/.exec(path);
        if (m && method === "POST" && UUID_RE.test(m[1]!)) return finish(createStage(pool, ctx, m[1]!, await readJson(req)));
      }
      {
        const m = /^\/api\/v1\/stages\/([^/]+)$/.exec(path);
        if (m && method === "PATCH" && UUID_RE.test(m[1]!)) return finish(updateStage(pool, ctx, m[1]!, await readJson(req)));
      }

      // leads
      if (method === "GET" && path === "/api/v1/leads") return finish(listLeads(pool, ctx, url));
      if (method === "POST" && path === "/api/v1/leads") {
        const result = await createLead(pool, ctx, await readJson(req));
        if (result.status === 201) {
          await onLeadCreated(pool, ctx, { leadId: (result.body as { id: string }).id }, runtimeClients).catch(() => undefined);
        }
        sendJson(res, result.status, result.body);
        return;
      }
      {
        const m = /^\/api\/v1\/leads\/([^/]+)$/.exec(path);
        if (m && UUID_RE.test(m[1]!)) {
          const id = m[1]!;
          if (method === "GET") return finish(getLead(pool, ctx, id));
          if (method === "PATCH") {
            const result = await updateLead(pool, ctx, id, await readJson(req));
            if (result.status === 200 && (result.body as { stage_id?: string }).stage_id) {
              await onStageChanged(pool, ctx, { leadId: id }, runtimeClients).catch(() => undefined);
            }
            sendJson(res, result.status, result.body);
            return;
          }
          if (method === "DELETE") return finish(deleteLead(pool, ctx, id));
        }
      }

      // incoming leads
      if (method === "GET" && path === "/api/v1/incoming-leads") {
        return finish(listLeads(pool, ctx, new URL("http://localhost/api/v1/leads?incoming=true")));
      }
      if (method === "POST" && path === "/api/v1/incoming-leads") return finish(createIncomingLead(pool, ctx, await readJson(req)));
      {
        const m = /^\/api\/v1\/incoming-leads\/([^/]+)\/(accept|decline)$/.exec(path);
        if (m && method === "POST" && UUID_RE.test(m[1]!)) {
          return finish(decideIncomingLead(pool, ctx, m[1]!, m[2]! as "accept" | "decline"));
        }
      }

      // contacts & companies
      if (method === "GET" && path === "/api/v1/contacts") return finish(listContacts(pool, ctx));
      if (method === "POST" && path === "/api/v1/contacts") return finish(createContact(pool, ctx, await readJson(req)));
      if (method === "GET" && path === "/api/v1/companies") return finish(listCompanies(pool, ctx));
      if (method === "POST" && path === "/api/v1/companies") return finish(createCompany(pool, ctx, await readJson(req)));

      // tasks & notes
      if (method === "GET" && path === "/api/v1/tasks") return finish(listTasks(pool, ctx, url));
      if (method === "POST" && path === "/api/v1/tasks") return finish(createTask(pool, ctx, await readJson(req)));
      {
        const m = /^\/api\/v1\/tasks\/([^/]+)$/.exec(path);
        if (m && method === "PATCH" && UUID_RE.test(m[1]!)) return finish(updateTask(pool, ctx, m[1]!, await readJson(req)));
      }
      if (method === "GET" && path === "/api/v1/notes") return finish(listNotes(pool, ctx, url));
      if (method === "POST" && path === "/api/v1/notes") return finish(createNote(pool, ctx, await readJson(req)));

      // tags
      if (method === "GET" && path === "/api/v1/tags") return finish(listTags(pool, ctx));

      // webhooks
      if (method === "GET" && path === "/api/v1/webhooks/events") return finish(Promise.resolve(webhookCatalog()));
      if (method === "GET" && path === "/api/v1/webhooks") return finish(listWebhooks(pool, ctx));
      if (method === "POST" && path === "/api/v1/webhooks") return finish(createWebhook(pool, ctx, await readJson(req)));
      {
        const m = /^\/api\/v1\/webhooks\/([^/]+)$/.exec(path);
        if (m && method === "DELETE" && UUID_RE.test(m[1]!)) return finish(deleteWebhook(pool, ctx, m[1]!));
      }
      {
        const m = /^\/api\/v1\/webhooks\/([^/]+)\/test$/.exec(path);
        if (m && method === "POST" && UUID_RE.test(m[1]!)) return finish(testWebhook(pool, ctx, m[1]!));
      }

      // WhatsApp + inbox
      if (method === "GET" && path === "/api/v1/channels/whatsapp/webhook") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode === "subscribe" && token && challenge) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(challenge);
          return;
        }
        sendError(res, 400, "invalid_challenge");
        return;
      }
      if (method === "POST" && path === "/api/v1/channels/whatsapp/webhook") {
        const raw = await readBody(req, 1024 * 1024);
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          sendError(res, 400, "invalid_json");
          return;
        }
        const sigHeader = req.headers["x-hub-signature-256"];
        return finish(
          ingestInbound(pool, ctx, body, raw.toString("utf8"), Array.isArray(sigHeader) ? sigHeader[0] : sigHeader, fakeWhatsAppClients, async (info) => {
            await onInboundMessage(pool, ctx, { conversationId: info.conversationId, messageText: info.text }, runtimeClients).catch(() => undefined);
            await onAiMessage(pool, ctx, { conversationId: info.conversationId, messageText: info.text }, runtimeClients).catch(() => undefined);
          }),
        );
      }
      if (method === "POST" && path === "/api/v1/channels/whatsapp/accounts") {
        if (process.env["NODE_ENV"] === "production") return sendError(res, 404, "not_found");
        return finish(connectChannel(pool, ctx, await readJson(req)));
      }
      if (method === "GET" && path === "/api/v1/channels/whatsapp/accounts") return finish(listChannels(pool, ctx));
      if (method === "POST" && path === "/api/v1/channels/whatsapp/dev/fake-inbound") {
        if (process.env["NODE_ENV"] === "production") return sendError(res, 404, "not_found");
        return finish(injectFakeInbound(pool, ctx, await readJson(req)));
      }
      if (method === "GET" && path === "/api/v1/conversations") return finish(listConversations(pool, ctx, url));
      if (method === "GET" && path === "/api/v1/templates") return finish(listTemplates(pool, ctx));
      if (method === "POST" && path === "/api/v1/templates") return finish(registerTemplate(pool, ctx, await readJson(req)));
      {
        const m = /^\/api\/v1\/templates\/([^/]+)\/submit$/.exec(path);
        if (m && method === "POST" && UUID_RE.test(m[1]!)) return finish(submitTemplate(pool, ctx, m[1]!));
      }
      {
        const m = /^\/api\/v1\/conversations\/([^/]+)(?:\/(messages|internal-notes|close|reopen|assign|opt-out))?$/.exec(path);
        if (m && UUID_RE.test(m[1]!)) {
          const convId = m[1]!;
          const sub = m[2];
          if (method === "GET" && !sub) return finish(getConversation(pool, ctx, convId));
          if (method === "POST" && sub === "messages") {
            return finish(sendMessage(pool, ctx, convId, await readJson(req), fakeWhatsAppClients));
          }
          if (method === "POST" && sub === "internal-notes") {
            return finish(addInternalNote(pool, ctx, convId, await readJson(req)));
          }
          if (method === "POST" && (sub === "close" || sub === "reopen" || sub === "assign" || sub === "opt-out")) {
            return finish(setConversationState(pool, ctx, convId, sub, (await readJson(req).catch(() => ({}))) as Record<string, unknown>));
          }
        }
      }

      // AI agents + copilot
      if (method === "GET" && path === "/api/v1/ai/agents") return finish(listAgents(pool, ctx));
      if (method === "POST" && path === "/api/v1/ai/agents") return finish(createAgent(pool, ctx, await readJson(req)));
      if (method === "GET" && path === "/api/v1/ai/sources") return finish(listSources(pool, ctx));
      if (method === "POST" && path === "/api/v1/ai/sources") return finish(addSource(pool, ctx, await readJson(req)));
      if (method === "POST" && path === "/api/v1/ai/copilot/summary") return finish(copilotSummarize(pool, ctx, await readJson(req)));
      if (method === "POST" && path === "/api/v1/ai/copilot/rewrite") return finish(copilotRewrite(pool, ctx, await readJson(req)));
      if (method === "POST" && path === "/api/v1/ai/copilot/suggest-reply") return finish(copilotSuggestReply(pool, ctx, await readJson(req)));
      {
        const m = /^\/api\/v1\/ai\/agents\/([^/]+)\/publish$/.exec(path);
        if (m && method === "POST" && UUID_RE.test(m[1]!)) return finish(publishAgent(pool, ctx, m[1]!));
      }

      // Dialog engine
      if (method === "GET" && path === "/api/v1/dialogs") return finish(listDialogs(pool, ctx));
      if (method === "POST" && path === "/api/v1/dialogs") return finish(createDialog(pool, ctx, await readJson(req)));
      {
        const m = /^\/api\/v1\/dialogs\/([^/]+)(?:\/(triggers|sessions|publish|simulate|launch))?$/.exec(path);
        if (m && UUID_RE.test(m[1]!)) {
          const botId = m[1]!;
          const sub = m[2];
          if (!sub && method === "GET") return finish(getDialog(pool, ctx, botId));
          if (!sub && method === "PUT") return finish(updateDialog(pool, ctx, botId, await readJson(req)));
          if (sub === "triggers" && method === "GET") return finish(listTriggers(pool, ctx, botId));
          if (sub === "triggers" && method === "POST") return finish(addTrigger(pool, ctx, botId, await readJson(req)));
          if (sub === "sessions" && method === "GET") return finish(listSessions(pool, ctx, botId));
          if (sub === "publish" && method === "POST") return finish(publishDialog(pool, ctx, botId));
          if (sub === "simulate" && method === "POST") return finish(simulate(pool, ctx, botId, await readJson(req)));
          if (sub === "launch" && method === "POST") return finish(launch(pool, ctx, botId, await readJson(req), runtimeClients));
        }
      }

      // Facebook (Messenger + lead forms)
      if (method === "GET" && path === "/api/v1/channels/facebook/webhook") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode === "subscribe" && token && challenge) {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(challenge);
          return;
        }
        sendError(res, 400, "invalid_challenge");
        return;
      }
      if (method === "POST" && path === "/api/v1/channels/facebook/webhook") {
        const raw = await readBody(req, 1024 * 1024);
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          sendError(res, 400, "invalid_json");
          return;
        }
        const sigHeader = req.headers["x-hub-signature-256"];
        return finish(ingestMessengerWebhook(pool, ctx, body, raw.toString("utf8"), Array.isArray(sigHeader) ? sigHeader[0] : sigHeader));
      }
      if (method === "POST" && path === "/api/v1/channels/facebook/accounts") {
        if (process.env["NODE_ENV"] === "production") return sendError(res, 404, "not_found");
        return finish(connectMessenger(pool, ctx, await readJson(req)));
      }
      if (method === "POST" && path === "/api/v1/channels/facebook/lead-forms/webhook") {
        const raw = await readBody(req, 1024 * 1024);
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          sendError(res, 400, "invalid_json");
          return;
        }
        const sigHeader = req.headers["x-hub-signature-256"];
        return finish(ingestLeadgenWebhook(pool, ctx, body, raw.toString("utf8"), Array.isArray(sigHeader) ? sigHeader[0] : sigHeader));
      }
      if (method === "GET" && path === "/api/v1/attribution") return finish(attributionStats(pool, ctx, url));

      // CSV
      if (method === "GET" && path === "/api/v1/export/leads.csv") {
        await exportLeadsCsv(pool, ctx, res);
        return;
      }
      if (method === "POST" && path === "/api/v1/import/leads") return finish(importLeadsCsv(pool, ctx, req));

      sendError(res, 404, "not_found");
    } catch (err) {
      const message = (err as Error).message;
      if (message === "payload_too_large") return sendError(res, 413, "payload_too_large");
      if (message === "invalid_json") return sendError(res, 400, "invalid_json");
      console.error("request failed:", err);
      sendError(res, 500, "internal_error");
    }
  };

  const server = createServer(handler);
  server.requestTimeout = 30_000;

  if (startWorker && pool) {
    const timer = setInterval(() => {
      import("@knotwire/core").then(({ deliverDue }) => deliverDue(pool).catch(() => undefined));
    }, 5_000);
    timer.unref();
  }

  return { server, pool };
}

export async function buildServer(options: ApiOptions = {}): Promise<ApiHandle> {
  const handle = createApi(options);
  // Migrations run via `npm run db:setup` with a superuser DSN (least-privilege
  // app role has no CREATE grant). Opt in here only for single-user dev setups.
  if (handle.pool && process.env["KNOTWIRE_APPLY_MIGRATIONS"] === "true") {
    await applyMigrations(handle.pool).catch((err) => {
      console.error("migrations failed:", (err as Error).message);
    });
  }
  return handle;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env["PORT"] ?? 8080);
  buildServer({ startWebhookWorker: true }).then(({ server }) => {
    server.listen(port, () => {
      console.log(`knotwire-api v${VERSION} listening on :${port}`);
    });
  });
}
