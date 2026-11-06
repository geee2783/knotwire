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
      if (method === "POST" && path === "/api/v1/leads") return finish(createLead(pool, ctx, await readJson(req)));
      {
        const m = /^\/api\/v1\/leads\/([^/]+)$/.exec(path);
        if (m && UUID_RE.test(m[1]!)) {
          const id = m[1]!;
          if (method === "GET") return finish(getLead(pool, ctx, id));
          if (method === "PATCH") return finish(updateLead(pool, ctx, id, await readJson(req)));
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
