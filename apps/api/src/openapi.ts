/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * Handwritten OpenAPI 3.1 document for /api/v1 (compact; request/response
 * shapes follow the handler implementations in routes-crm.ts / routes-misc.ts).
 */

export const KNOTWIRE_OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Knotwire Public API",
    version: "0.2.0",
    license: { name: "AGPL-3.0-only" },
    description:
      "Independent implementation. All mutating routes require a Bearer token (OAuth2 or long-lived token issuance ships in M6). Every request is tenant-scoped via RLS.",
  },
  servers: [{ url: "http://localhost:8080" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
    schemas: {
      Pipeline: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", maxLength: 200 },
          stages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                sort_order: { type: "integer" },
                color: { type: "string" },
                is_won: { type: "boolean" },
                is_lost: { type: "boolean" },
              },
            },
          },
        },
      },
      LeadCreate: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          price: { type: ["number", "null"] },
          pipeline_id: { type: ["string", "null"], format: "uuid" },
          stage_id: { type: ["string", "null"], format: "uuid" },
          responsible_user_id: { type: ["string", "null"], format: "uuid" },
          source_id: { type: ["string", "null"], format: "uuid" },
          custom_fields: { type: "object" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      IncomingLeadCreate: {
        type: "object",
        required: ["name"],
        properties: {
          kind: { type: "string", description: "free-form source label, e.g. facebook-lead-ad, marketplace" },
          name: { type: "string" },
          price: { type: ["number", "null"] },
          source_id: { type: ["string", "null"], format: "uuid" },
          custom_fields: { type: "object" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
      TaskCreate: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          lead_id: { type: ["string", "null"], format: "uuid" },
          due_at: { type: ["string", "null"], format: "date-time" },
        },
      },
      WebhookCreate: {
        type: "object",
        required: ["url", "events"],
        properties: {
          url: { type: "string", format: "uri" },
          events: {
            type: "array",
            items: { enum: ["lead.created", "lead.updated", "lead.stage_changed", "lead.lost", "task.created", "task.completed"] },
          },
          description: { type: ["string", "null"] },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/healthz": { get: { summary: "Liveness", responses: { "200": { description: "ok" } } } },
    "/readyz": { get: { summary: "Readiness incl. Postgres", responses: { "200": { description: "ready" }, "503": { description: "degraded" } } } },
    "/api/v1/pipelines": {
      get: { summary: "List pipelines with stages", responses: { "200": { description: "ok" } } },
      post: { summary: "Create pipeline (optionally with stages)", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Pipeline" } } } }, responses: { "201": { description: "created" } } },
    },
    "/api/v1/pipelines/{pipelineId}/stages": {
      post: { summary: "Add stage to pipeline", parameters: [{ name: "pipelineId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "201": { description: "created" }, "404": { description: "pipeline_not_found" } } },
    },
    "/api/v1/stages/{stageId}": { patch: { summary: "Update stage", parameters: [{ name: "stageId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" }, "404": { description: "stage_not_found" } } } },
    "/api/v1/leads": {
      get: { summary: "List leads", parameters: [{ name: "pipeline_id", in: "query", schema: { type: "string", format: "uuid" } }, { name: "stage_id", in: "query", schema: { type: "string", format: "uuid" } }, { name: "incoming", in: "query", schema: { type: "string", enum: ["true", "false"] } }, { name: "q", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer" } }, { name: "offset", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "ok" } } },
      post: { summary: "Create lead", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LeadCreate" } } } }, responses: { "201": { description: "created" } } },
    },
    "/api/v1/leads/{leadId}": {
      get: { summary: "Get lead", parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" }, "404": { description: "lead_not_found" } } },
      patch: { summary: "Update lead (stage moves emit lead.stage_changed)", parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" } } },
      delete: { summary: "Delete lead (admin/manager)", parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" } } },
    },
    "/api/v1/incoming-leads": {
      get: { summary: "List incoming (unsorted) leads", responses: { "200": { description: "ok" } } },
      post: { summary: "Create incoming lead (e.g. from Facebook Lead Ads / Marketplace ref)", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/IncomingLeadCreate" } } } }, responses: { "201": { description: "created" } } },
    },
    "/api/v1/incoming-leads/{leadId}/accept": { post: { summary: "Accept incoming lead into the default pipeline", parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" }, "409": { description: "no_pipeline" } } } },
    "/api/v1/incoming-leads/{leadId}/decline": { post: { summary: "Decline incoming lead", parameters: [{ name: "leadId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" } } } },
    "/api/v1/tasks": {
      get: { summary: "List tasks", parameters: [{ name: "lead_id", in: "query", schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" } } },
      post: { summary: "Create task", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/TaskCreate" } } } }, responses: { "201": { description: "created" } } },
    },
    "/api/v1/tasks/{taskId}": { patch: { summary: "Update/complete task", parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" } } } },
    "/api/v1/notes": {
      get: { summary: "List notes (filter lead_id|contact_id)", parameters: [{ name: "lead_id", in: "query", schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" } } },
      post: { summary: "Create note", responses: { "201": { description: "created" } } },
    },
    "/api/v1/contacts": { get: { summary: "List contacts", responses: { "200": { description: "ok" } } }, post: { summary: "Create contact", responses: { "201": { description: "created" } } } },
    "/api/v1/companies": { get: { summary: "List companies", responses: { "200": { description: "ok" } } }, post: { summary: "Create company", responses: { "201": { description: "created" } } } },
    "/api/v1/tags": { get: { summary: "Distinct tags in use", responses: { "200": { description: "ok" } } } },
    "/api/v1/webhooks": {
      get: { summary: "List outbound webhooks (secrets are never returned)", responses: { "200": { description: "ok" } } },
      post: { summary: "Register webhook; the HMAC secret is returned once", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookCreate" } } } }, responses: { "201": { description: "created; secret in response" } } },
    },
    "/api/v1/webhooks/{webhookId}": { delete: { summary: "Delete webhook (admin/manager)", parameters: [{ name: "webhookId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" } } } },
    "/api/v1/webhooks/{webhookId}/test": { post: { summary: "Enqueue and deliver a test event", parameters: [{ name: "webhookId", in: "path", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "ok" } } } },
    "/api/v1/webhooks/events": { get: { summary: "Event catalog", responses: { "200": { description: "ok" } } } },
    "/api/v1/channels/whatsapp/accounts": { post: { summary: "Connect WhatsApp channel (dev only; disabled in production builds)" }, get: { summary: "List channels (tokens never returned)" } },
    "/api/v1/channels/whatsapp/webhook": { get: { summary: "Meta hub challenge" }, post: { summary: "WhatsApp inbound webhook (HMAC verified)" } },
    "/api/v1/channels/facebook/accounts": { post: { summary: "Connect Messenger page (dev only)" } },
    "/api/v1/channels/facebook/webhook": { get: { summary: "Meta hub challenge (app_secret exchange)" }, post: { summary: "Messenger page events: messages, postbacks, referrals (m.me ref attribution)" } },
    "/api/v1/channels/facebook/lead-forms/webhook": { post: { summary: "FB Lead Ads leadgen events -> incoming leads" } },
    "/api/v1/conversations": { get: { summary: "List conversations (inbox)" } },
    "/api/v1/conversations/{conversationId}": { get: { summary: "Get conversation thread + service window" } },
    "/api/v1/conversations/{conversationId}/messages": { post: { summary: "Send message (24h window enforced; template after close)" } },
    "/api/v1/conversations/{conversationId}/internal-notes": { post: { summary: "Private team note (never sent)" } },
    "/api/v1/conversations/{conversationId}/close": { post: { summary: "Close conversation" } },
    "/api/v1/conversations/{conversationId}/reopen": { post: { summary: "Reopen conversation" } },
    "/api/v1/conversations/{conversationId}/assign": { post: { summary: "Assign conversation" } },
    "/api/v1/conversations/{conversationId}/opt-out": { post: { summary: "Opt-out registry write (blocks sends)" } },
    "/api/v1/templates": { get: { summary: "List WA templates" }, post: { summary: "Register template (PENDING)" } },
    "/api/v1/templates/{templateId}/submit": { post: { summary: "Submit template for moderation" } },
    "/api/v1/attribution": { get: { summary: "Per-ref attribution stats (?ref=)", parameters: [{ name: "ref", in: "query", schema: { type: "string" } }] } },
    "/api/v1/import/leads": { post: { summary: "Import leads from CSV (first row = headers name,price,stage,tags)", responses: { "200": { description: "created/failed counts" } } } },
    "/api/v1/export/leads.csv": { get: { summary: "Export leads as CSV", responses: { "200": { description: "text/csv" } } } },
    "/api/v1/openapi.json": { get: { summary: "This document", responses: { "200": { description: "openapi 3.1 json" } } } },
  },
} as const;
