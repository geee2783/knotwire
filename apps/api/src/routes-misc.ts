/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * /api/v1 handlers (cont): contacts, companies, tasks, notes, tags,
 * outbound webhooks, CSV import/export.
 */

import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  withTenant,
  enqueueWebhooks,
  deliverDue,
} from "@knotwire/core";
import type { RequestContext } from "./context.js";
import { readBody, requireWriteRole, requireManagerRole, sendJson, sendError } from "./context.js";
import { writeAudit } from "./audit.js";
import type { HandlerResult } from "./routes-crm.js";

const asUuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;

const text = (v: unknown, max = 500): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v
  : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : null;

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim().slice(0, 100)) : [];

const jsonObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const csvEscape = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function parseCsv(textInput: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < textInput.length; i++) {
    const ch = textInput[i];
    if (inQuotes) {
      if (ch === '"') {
        if (textInput[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && textInput[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.some((c) => c.length)) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.length)) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0]!.map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? "").trim();
    });
    return obj;
  });
}

// ---------- contacts ----------

export async function listContacts(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, name, phone, email, custom_fields, tags, responsible_user_id, created_at, updated_at FROM contacts ORDER BY created_at DESC LIMIT 200",
    );
    return r.rows;
  });
  return { status: 200, body: { contacts: rows } };
}

export async function createContact(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 300);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const contact = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO contacts (tenant_id, name, phone, email, custom_fields, tags, responsible_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [ctx.tenantId, name, text(body["phone"], 60), text(body["email"], 200), JSON.stringify(jsonObj(body["custom_fields"])), strArray(body["tags"]), asUuid(body["responsible_user_id"])],
    );
    await writeAudit(c, ctx, { entity: "contact", entityId: r.rows[0].id, action: "created", after: r.rows[0], before: null });
    return r.rows[0];
  });
  return { status: 201, body: contact };
}

// ---------- companies ----------

export async function listCompanies(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, name, phone, email, website, custom_fields, tags, responsible_user_id, created_at, updated_at FROM companies ORDER BY created_at DESC LIMIT 200",
    );
    return r.rows;
  });
  return { status: 200, body: { companies: rows } };
}

export async function createCompany(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 300);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const company = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO companies (tenant_id, name, phone, email, website, custom_fields, tags, responsible_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
      [ctx.tenantId, name, text(body["phone"], 60), text(body["email"], 200), text(body["website"], 300), JSON.stringify(jsonObj(body["custom_fields"])), strArray(body["tags"]), asUuid(body["responsible_user_id"])],
    );
    await writeAudit(c, ctx, { entity: "company", entityId: r.rows[0].id, action: "created", after: r.rows[0], before: null });
    return r.rows[0];
  });
  return { status: 201, body: company };
}

// ---------- tasks ----------

export async function listTasks(pool: pg.Pool, ctx: RequestContext, url: URL): Promise<HandlerResult> {
  const leadId = asUuid(url.searchParams.get("lead_id"));
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const params: unknown[] = [];
    const where = leadId ? "WHERE lead_id = $1" : "";
    if (leadId) params.push(leadId);
    const r = await c.query(
      `SELECT id, lead_id, contact_id, company_id, title, due_at, responsible_user_id, done_at, created_at, updated_at
       FROM tasks ${where} ORDER BY due_at NULLS LAST, created_at DESC LIMIT 200`,
      params,
    );
    return r.rows;
  });
  return { status: 200, body: { tasks: rows } };
}

export async function createTask(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const title = text(body["title"], 300);
  if (!title) return { status: 400, body: { error: "title_required" } };
  const task = await withTenant(pool, ctx.tenantId, async (c) => {
    const dueAt = text(body["due_at"], 40);
    const r = await c.query(
      "INSERT INTO tasks (tenant_id, lead_id, contact_id, company_id, title, due_at, responsible_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *",
      [ctx.tenantId, asUuid(body["lead_id"]), asUuid(body["contact_id"]), asUuid(body["company_id"]), title, dueAt ? new Date(dueAt) : null, asUuid(body["responsible_user_id"])],
    );
    await writeAudit(c, ctx, { entity: "task", entityId: r.rows[0].id, action: "created", after: r.rows[0], before: null });
    return r.rows[0];
  });
  await enqueueWebhooks(pool, ctx.tenantId, "task.created", task as Record<string, unknown>);
  await deliverDue(pool).catch(() => undefined);
  return { status: 201, body: task };
}

export async function updateTask(pool: pg.Pool, ctx: RequestContext, taskId: string, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const task = await withTenant(pool, ctx.tenantId, async (c) => {
    const cur = await c.query("SELECT * FROM tasks WHERE id = $1", [taskId]);
    if (cur.rowCount === 0) return null;
    const before = cur.rows[0];
    const title = text(body["title"], 300) ?? before.title;
    const dueAt = body["due_at"] === undefined ? before.due_at : body["due_at"] === null ? null : new Date(String(body["due_at"]));
    const doneAt = body["done"] === true ? new Date() : body["done"] === false ? null : before.done_at;
    const r = await c.query(
      "UPDATE tasks SET title=$2, due_at=$3, done_at=$4 WHERE id=$1 RETURNING *",
      [taskId, title, dueAt, doneAt],
    );
    await writeAudit(c, ctx, { entity: "task", entityId: taskId, action: "updated", after: r.rows[0], before });
    return r.rows[0] as Record<string, unknown>;
  });
  if (!task) return { status: 404, body: { error: "task_not_found" } };
  if (body["done"] === true) {
    await enqueueWebhooks(pool, ctx.tenantId, "task.completed", task);
    await deliverDue(pool).catch(() => undefined);
  }
  return { status: 200, body: task };
}

// ---------- notes ----------

export async function listNotes(pool: pg.Pool, ctx: RequestContext, url: URL): Promise<HandlerResult> {
  const leadId = asUuid(url.searchParams.get("lead_id"));
  const contactId = asUuid(url.searchParams.get("contact_id"));
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (leadId) {
      params.push(leadId);
      clauses.push(`lead_id = $${params.length}`);
    }
    if (contactId) {
      params.push(contactId);
      clauses.push(`contact_id = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await c.query(
      `SELECT id, lead_id, contact_id, company_id, body, created_by, created_at FROM notes ${where} ORDER BY created_at DESC LIMIT 200`,
      params,
    );
    return r.rows;
  });
  return { status: 200, body: { notes: rows } };
}

export async function createNote(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const note = text(body["body"], 5000);
  if (!note) return { status: 400, body: { error: "body_required" } };
  const created = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO notes (tenant_id, lead_id, contact_id, company_id, body, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [ctx.tenantId, asUuid(body["lead_id"]), asUuid(body["contact_id"]), asUuid(body["company_id"]), note, ctx.userId],
    );
    await writeAudit(c, ctx, { entity: "note", entityId: r.rows[0].id, action: "created", after: r.rows[0], before: null });
    return r.rows[0];
  });
  return { status: 201, body: created };
}

// ---------- tags ----------

export async function listTags(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT DISTINCT unnest(tags) AS tag FROM leads WHERE tenant_id = $1 ORDER BY 1",
      [ctx.tenantId],
    );
    return r.rows.map((x) => x.tag as string);
  });
  return { status: 200, body: { tags: rows } };
}

// ---------- webhooks ----------

const WEBHOOK_EVENTS = [
  "lead.created",
  "lead.updated",
  "lead.stage_changed",
  "lead.lost",
  "task.created",
  "task.completed",
] as const;

export function webhookCatalog(): HandlerResult {
  return { status: 200, body: { events: [...WEBHOOK_EVENTS], signature_header: "x-knotwire-signature", signature_scheme: "hmac-sha256; header value sha256=<hex>; HMAC of the raw request body" } };
}

export async function listWebhooks(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "SELECT id, url, events, active, description, created_at FROM webhooks ORDER BY created_at DESC",
    );
    return r.rows;
  });
  return { status: 200, body: { webhooks: rows } };
}

export async function createWebhook(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const url = text(body["url"], 1000);
  const events = strArray(body["events"]);
  if (!url?.startsWith("https://") && !url?.startsWith("http://")) return { status: 400, body: { error: "url_required" } };
  const unknown = events.filter((e) => !(WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (events.length === 0 || unknown.length) return { status: 400, body: { error: "invalid_events", unknown } };
  const secret = randomBytes(24).toString("hex");
  const hook = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      "INSERT INTO webhooks (tenant_id, url, secret, events, description) VALUES ($1,$2,$3,$4,$5) RETURNING id, url, events, active, description, created_at",
      [ctx.tenantId, url, secret, events, text(body["description"], 300)],
    );
    await writeAudit(c, ctx, { entity: "webhook", entityId: r.rows[0].id, action: "created", after: { ...r.rows[0], secret: "[redacted]" }, before: null });
    return r.rows[0];
  });
  return { status: 201, body: { ...hook, secret } };
}

export async function deleteWebhook(pool: pg.Pool, ctx: RequestContext, webhookId: string): Promise<HandlerResult> {
  if (!requireManagerRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const removed = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("DELETE FROM webhooks WHERE id = $1 RETURNING id", [webhookId]);
    if (r.rowCount === 0) return false;
    await writeAudit(c, ctx, { entity: "webhook", entityId: webhookId, action: "deleted", after: null, before: { id: webhookId } });
    return true;
  });
  if (!removed) return { status: 404, body: { error: "webhook_not_found" } };
  return { status: 200, body: { deleted: true, id: webhookId } };
}

export async function testWebhook(pool: pg.Pool, ctx: RequestContext, webhookId: string): Promise<HandlerResult> {
  const hook = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, url, events FROM webhooks WHERE id = $1 AND active = true", [webhookId]);
    return r.rows[0] ?? null;
  });
  if (!hook) return { status: 404, body: { error: "webhook_not_found" } };
  const enqueued = await enqueueWebhooks(pool, ctx.tenantId, String(hook.events[0]), { test: true, webhook_id: webhookId });
  const report = await deliverDue(pool);
  return { status: 200, body: { enqueued, ...report } };
}

// ---------- CSV import / export ----------

export async function exportLeadsCsv(pool: pg.Pool, ctx: RequestContext, res: import("node:http").ServerResponse): Promise<void> {
  const rows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `SELECT l.id, l.name, l.price, l.tags, l.incoming, l.outcome, l.created_at,
              s.name AS stage_name, p.name AS pipeline_name
       FROM leads l LEFT JOIN stages s ON s.id = l.stage_id LEFT JOIN pipelines p ON p.id = l.pipeline_id
       ORDER BY l.created_at DESC LIMIT 10000`,
    );
    return r.rows;
  });
  const header = ["id","name","price","stage","pipeline","tags","incoming","outcome","created_at"].join(",");
  const body = rows.map((row) =>
    [
      csvEscape(row.id),
      csvEscape(row.name),
      csvEscape(row.price),
      csvEscape(row.stage_name),
      csvEscape(row.pipeline_name),
      csvEscape((row.tags ?? []).join(";")),
      csvEscape(row.incoming),
      csvEscape(row.outcome),
      csvEscape(row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at),
    ].join(","),
  );
  const payload = [header, ...body].join("\n");
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": 'attachment; filename="knotwire-leads.csv"',
    "cache-control": "no-store",
  });
  res.end(payload);
}

export async function importLeadsCsv(pool: pg.Pool, ctx: RequestContext, req: import("node:http").IncomingMessage): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const raw = await readBody(req, 5 * 1024 * 1024);
  const rows = parseCsv(raw.toString("utf8"));
  const pipelineId = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id FROM pipelines ORDER BY is_default DESC, sort_order LIMIT 1");
    return r.rows[0]?.id as string | undefined;
  });
  if (!pipelineId) return { status: 409, body: { error: "no_pipeline" } };
  const stageRows = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query("SELECT id, lower(name) AS lname FROM stages WHERE pipeline_id = $1", [pipelineId]);
    return r.rows;
  });
  const firstStage = stageRows[0]?.id;
  const stageByName = new Map(stageRows.map((s) => [s.lname as string, s.id as string]));
  let created = 0;
  const errors: Array<{ row: number; error: string }> = [];
  for (const [index, row] of rows.entries()) {
    const name = (row["name"] ?? "").trim();
    if (!name) {
      errors.push({ row: index + 2, error: "name_required" });
      continue;
    }
    const stageName = (row["stage"] ?? "").toLowerCase();
    const stageId = (stageName && stageByName.get(stageName)) || firstStage || null;
    try {
      await withTenant(pool, ctx.tenantId, async (c) => {
        await c.query(
          "INSERT INTO leads (tenant_id, pipeline_id, stage_id, name, price, tags) VALUES ($1,$2,$3,$4,$5,$6)",
          [ctx.tenantId, pipelineId, stageId, name.slice(0, 300), row["price"] ? Number(row["price"].replace(/[^0-9.\-]/g, "")) || null : null, (row["tags"] ?? "").split(/[;|]/).map((t) => t.trim()).filter(Boolean)],
        );
      });
      created += 1;
    } catch (err) {
      errors.push({ row: index + 2, error: (err as Error).message.slice(0, 120) });
    }
  }
  return { status: 200, body: { created, failed: errors.length, errors: errors.slice(0, 25) } };
}
