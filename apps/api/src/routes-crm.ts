/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * /api/v1 route handlers: pipelines, stages, leads, incoming leads, tasks,
 * notes, contacts, companies, tags, outbound webhooks, CSV import/export.
 */

import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import {
  withTenant,
  enqueueWebhooks,
  deliverDue,
} from "@knotwire/core";
import type { AuditAction, AuditInput } from "./audit.js";
import type { RequestContext } from "./context.js";
import { sendJson, sendError, readJson, readBody, requireWriteRole, requireManagerRole } from "./context.js";
import { writeAudit } from "./audit.js";

export interface HandlerResult {
  status: number;
  body: unknown;
}

const asUuid = (v: unknown): string | null =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
    ? v
    : null;

const text = (v: unknown, max = 500): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : null;

const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => String(x).trim().slice(0, 100)) : [];

const jsonObj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

async function defaultPipelineId(pool: pg.Pool, tenantId: string): Promise<string | null> {
  const { rows } = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query(
      "SELECT id FROM pipelines ORDER BY is_default DESC, sort_order ASC, created_at ASC LIMIT 1",
    );
    return r;
  });
  return rows[0]?.id ?? null;
}

async function firstStageId(
  pool: pg.Pool,
  tenantId: string,
  pipelineId: string,
): Promise<string | null> {
  const { rows } = await withTenant(pool, tenantId, async (c) => {
    const r = await c.query(
      "SELECT id FROM stages WHERE pipeline_id = $1 ORDER BY sort_order ASC, created_at ASC LIMIT 1",
      [pipelineId],
    );
    return r;
  });
  return rows[0]?.id ?? null;
}

async function enqueueAndDeliver(
  pool: pg.Pool,
  tenantId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await enqueueWebhooks(pool, tenantId, type, payload);
  await deliverDue(pool).catch(() => undefined);
}

// ---------- pipelines & stages ----------

export async function listPipelines(pool: pg.Pool, ctx: RequestContext): Promise<HandlerResult> {
  const pipelines = await withTenant(pool, ctx.tenantId, async (c) => {
    const p = await c.query(
      "SELECT id, name, is_default, sort_order, created_at FROM pipelines ORDER BY sort_order, created_at",
    );
    const s = await c.query(
      "SELECT id, pipeline_id, name, sort_order, color, is_won, is_lost FROM stages ORDER BY sort_order, created_at",
    );
    return p.rows.map((row) => ({
      ...row,
      stages: s.rows.filter((st) => st.pipeline_id === row.id),
    }));
  });
  return { status: 200, body: { pipelines } };
}

export async function createPipeline(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 200);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const stages = Array.isArray(body["stages"]) ? body["stages"] : [];
  const { value, snapshot } = await withTenant(pool, ctx.tenantId, async (c) => {
    const isFirst = (await c.query("SELECT count(*)::int AS n FROM pipelines")).rows[0].n === 0;
    const p = await c.query(
      "INSERT INTO pipelines (tenant_id, name, is_default, sort_order) VALUES ($1, $2, $3, 0) RETURNING id, name, is_default, sort_order",
      [ctx.tenantId, name, isFirst],
    );
    const pipeline = p.rows[0];
    const createdStages = [];
    for (const [i, stage] of stages.entries()) {
      const s = (stage ?? {}) as Record<string, unknown>;
      const stName = text(s["name"], 200);
      if (!stName) continue;
      const stColor = text(s["color"], 30) ?? "#64748b";
      const sortOrder = num(s["sort_order"]) ?? i;
      const inserted = await c.query(
        "INSERT INTO stages (tenant_id, pipeline_id, name, sort_order, color, is_won, is_lost) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, sort_order, color, is_won, is_lost",
        [ctx.tenantId, pipeline.id, stName, sortOrder, stColor, s["is_won"] === true, s["is_lost"] === true],
      );
      createdStages.push(inserted.rows[0]);
    }
    const snapshot = { ...pipeline, stages: createdStages };
    await writeAudit(c, ctx, { entity: "pipeline", entityId: pipeline.id, action: "created", after: snapshot, before: null });
    return { value: pipeline, snapshot };
  });
  return { status: 201, body: snapshot ?? value };
}

export async function createStage(pool: pg.Pool, ctx: RequestContext, pipelineId: string, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 200);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const result = await withTenant(pool, ctx.tenantId, async (c) => {
    const ok = await c.query("SELECT 1 FROM pipelines WHERE id = $1", [pipelineId]);
    if (ok.rowCount === 0) return null;
    const sort = num(body["sort_order"]) ?? 0;
    const inserted = await c.query(
      "INSERT INTO stages (tenant_id, pipeline_id, name, sort_order, color, is_won, is_lost) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, sort_order, color, is_won, is_lost",
      [ctx.tenantId, pipelineId, name, sort, text(body["color"], 30) ?? "#64748b", body["is_won"] === true, body["is_lost"] === true],
    );
    await writeAudit(c, ctx, { entity: "stage", entityId: inserted.rows[0].id, action: "created", after: inserted.rows[0], before: null });
    return inserted.rows[0];
  });
  if (!result) return { status: 404, body: { error: "pipeline_not_found" } };
  return { status: 201, body: result };
}

export async function updateStage(pool: pg.Pool, ctx: RequestContext, stageId: string, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const result = await withTenant(pool, ctx.tenantId, async (c) => {
    const cur = await c.query("SELECT * FROM stages WHERE id = $1", [stageId]);
    if (cur.rowCount === 0) return null;
    const before = cur.rows[0];
    const next = {
      name: text(body["name"], 200) ?? before.name,
      sort_order: num(body["sort_order"]) ?? before.sort_order,
      color: text(body["color"], 30) ?? before.color,
      is_won: typeof body["is_won"] === "boolean" ? body["is_won"] : before.is_won,
      is_lost: typeof body["is_lost"] === "boolean" ? body["is_lost"] : before.is_lost,
    };
    const upd = await c.query(
      "UPDATE stages SET name=$2, sort_order=$3, color=$4, is_won=$5, is_lost=$6 WHERE id=$1 RETURNING id, name, sort_order, color, is_won, is_lost",
      [stageId, next.name, next.sort_order, next.color, next.is_won, next.is_lost],
    );
    await writeAudit(c, ctx, { entity: "stage", entityId: stageId, action: "updated", after: upd.rows[0], before });
    return upd.rows[0];
  });
  if (!result) return { status: 404, body: { error: "stage_not_found" } };
  return { status: 200, body: result };
}

// ---------- leads ----------

const LEAD_SELECT = `SELECT id, pipeline_id, stage_id, name, price, responsible_user_id, source_id,
  contact_id, company_id, custom_fields, tags, incoming, outcome, closed_at, created_at, updated_at FROM leads`;

export async function listLeads(pool: pg.Pool, ctx: RequestContext, url: URL): Promise<HandlerResult> {
  const params: unknown[] = [];
  const clauses: string[] = [];
  const pipelineId = asUuid(url.searchParams.get("pipeline_id"));
  const stageId = asUuid(url.searchParams.get("stage_id"));
  const incoming = url.searchParams.get("incoming");
  const q = text(url.searchParams.get("q"), 200);
  if (pipelineId) {
    params.push(pipelineId);
    clauses.push(`pipeline_id = $${params.length}`);
  }
  if (stageId) {
    params.push(stageId);
    clauses.push(`stage_id = $${params.length}`);
  }
  if (incoming === "true" || incoming === "false") {
    params.push(incoming === "true");
    clauses.push(`incoming = $${params.length}`);
  }
  if (q) {
    params.push(`%${q}%`);
    clauses.push(`name ILIKE $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(num(url.searchParams.get("limit")) ?? 50, 1), 200);
  const offset = Math.max(num(url.searchParams.get("offset")) ?? 0, 0);
  params.push(limit, offset);
  const leads = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `${LEAD_SELECT} ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return r.rows;
  });
  return { status: 200, body: { leads, count: leads.length } };
}

export async function createLead(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 300);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const pipelineId = asUuid(body["pipeline_id"]) ?? (await defaultPipelineId(pool, ctx.tenantId));
  const stageId = asUuid(body["stage_id"]) ?? (pipelineId ? await firstStageId(pool, ctx.tenantId, pipelineId) : null);
  const lead = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO leads (tenant_id, pipeline_id, stage_id, name, price, responsible_user_id, source_id, contact_id, company_id, custom_fields, tags, incoming)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false)
       RETURNING id, pipeline_id, stage_id, name, price, responsible_user_id, source_id, contact_id, company_id, custom_fields, tags, incoming, outcome, closed_at, created_at, updated_at`,
      [
        ctx.tenantId,
        pipelineId,
        stageId,
        name,
        num(body["price"]),
        asUuid(body["responsible_user_id"]),
        asUuid(body["source_id"]),
        asUuid(body["contact_id"]),
        asUuid(body["company_id"]),
        JSON.stringify(jsonObj(body["custom_fields"])),
        strArray(body["tags"]),
      ],
    );
    const row = r.rows[0];
    await writeAudit(c, ctx, { entity: "lead", entityId: row.id, action: "created", after: row, before: null });
    return row;
  });
  await enqueueAndDeliver(pool, ctx.tenantId, "lead.created", lead);
  return { status: 201, body: lead };
}

export async function getLead(pool: pg.Pool, ctx: RequestContext, leadId: string): Promise<HandlerResult> {
  const lead = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(`${LEAD_SELECT} WHERE id = $1`, [leadId]);
    return r.rows[0] ?? null;
  });
  if (!lead) return { status: 404, body: { error: "lead_not_found" } };
  return { status: 200, body: lead };
}

export async function updateLead(pool: pg.Pool, ctx: RequestContext, leadId: string, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const { lead, stageChanged } = await withTenant(pool, ctx.tenantId, async (c) => {
    const cur = await c.query(`${LEAD_SELECT} WHERE id = $1`, [leadId]);
    if (cur.rowCount === 0) return { lead: null, stageChanged: false };
    const before = cur.rows[0];
    const next = {
      pipeline_id: asUuid(body["pipeline_id"]) ?? before.pipeline_id,
      stage_id: body["stage_id"] === undefined ? before.stage_id : asUuid(body["stage_id"]),
      name: text(body["name"], 300) ?? before.name,
      price: body["price"] === undefined ? before.price : num(body["price"]),
      responsible_user_id: body["responsible_user_id"] === undefined ? before.responsible_user_id : asUuid(body["responsible_user_id"]),
      source_id: body["source_id"] === undefined ? before.source_id : asUuid(body["source_id"]),
      contact_id: body["contact_id"] === undefined ? before.contact_id : asUuid(body["contact_id"]),
      company_id: body["company_id"] === undefined ? before.company_id : asUuid(body["company_id"]),
      custom_fields: body["custom_fields"] === undefined ? before.custom_fields : jsonObj(body["custom_fields"]),
      tags: body["tags"] === undefined ? before.tags : strArray(body["tags"]),
      incoming: typeof body["incoming"] === "boolean" ? body["incoming"] : before.incoming,
      outcome: body["outcome"] === undefined ? before.outcome : text(body["outcome"], 100),
      closed_at: body["closed_at"] === undefined ? before.closed_at : body["closed_at"] === null ? null : text(String(body["closed_at"]), 40),
    };
    const stageChanged = next.stage_id !== before.stage_id;
    const r = await c.query(
      `UPDATE leads SET pipeline_id=$2, stage_id=$3, name=$4, price=$5, responsible_user_id=$6, source_id=$7,
         contact_id=$8, company_id=$9, custom_fields=$10, tags=$11, incoming=$12, outcome=$13, closed_at=$14
       WHERE id=$1
       RETURNING id, pipeline_id, stage_id, name, price, responsible_user_id, source_id, contact_id, company_id, custom_fields, tags, incoming, outcome, closed_at, created_at, updated_at`,
      [
        leadId,
        next.pipeline_id,
        next.stage_id,
        next.name,
        next.price,
        next.responsible_user_id,
        next.source_id,
        next.contact_id,
        next.company_id,
        JSON.stringify(next.custom_fields),
        next.tags,
        next.incoming,
        next.outcome,
        next.closed_at,
      ],
    );
    const after = r.rows[0];
    await writeAudit(c, ctx, {
      entity: "lead",
      entityId: leadId,
      action: stageChanged ? "stage_changed" : "updated",
      after,
      before,
    });
    return { lead: after, stageChanged };
  });
  if (!lead) return { status: 404, body: { error: "lead_not_found" } };
  await enqueueAndDeliver(pool, ctx.tenantId, stageChanged ? "lead.stage_changed" : "lead.updated", lead);
  return { status: 200, body: lead };
}

export async function deleteLead(pool: pg.Pool, ctx: RequestContext, leadId: string): Promise<HandlerResult> {
  if (!requireManagerRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const deleted = await withTenant(pool, ctx.tenantId, async (c) => {
    const cur = await c.query(`${LEAD_SELECT} WHERE id = $1`, [leadId]);
    if (cur.rowCount === 0) return null;
    const before = cur.rows[0];
    await c.query("DELETE FROM leads WHERE id = $1", [leadId]);
    await writeAudit(c, ctx, { entity: "lead", entityId: leadId, action: "deleted", after: null, before });
    return before;
  });
  if (!deleted) return { status: 404, body: { error: "lead_not_found" } };
  return { status: 200, body: { deleted: true, id: leadId } };
}

// ---------- incoming leads ----------

export async function createIncomingLead(pool: pg.Pool, ctx: RequestContext, body: Record<string, unknown>): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const name = text(body["name"], 300);
  if (!name) return { status: 400, body: { error: "name_required" } };
  const incoming = await withTenant(pool, ctx.tenantId, async (c) => {
    const r = await c.query(
      `INSERT INTO leads (tenant_id, name, price, source_id, custom_fields, tags, incoming)
       VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [
        ctx.tenantId,
        name,
        num(body["price"]),
        asUuid(body["source_id"]),
        JSON.stringify(jsonObj(body["custom_fields"])),
        strArray(body["tags"] ?? [body["kind"] ? String(body["kind"]) : "inbound"]),
      ],
    );
    const row = r.rows[0];
    await writeAudit(c, ctx, { entity: "incoming_lead", entityId: row.id, action: "created", after: row, before: null });
    return row;
  });
  await enqueueAndDeliver(pool, ctx.tenantId, "lead.created", incoming);
  return { status: 201, body: incoming };
}

export async function decideIncomingLead(pool: pg.Pool, ctx: RequestContext, leadId: string, decision: "accept" | "decline"): Promise<HandlerResult> {
  if (!requireWriteRole(ctx)) return { status: 403, body: { error: "forbidden" } };
  const result = await withTenant(pool, ctx.tenantId, async (c) => {
    const cur = await c.query("SELECT * FROM leads WHERE id = $1", [leadId]);
    if (cur.rowCount === 0) return { status: 404 as const };
    const before = cur.rows[0];
    if (decision === "accept") {
      const pipelineId = await defaultPipelineId(pool, ctx.tenantId);
      if (!pipelineId) return { status: 409 as const, error: "no_pipeline" } as const;
      const stageId = await firstStageId(pool, ctx.tenantId, pipelineId);
      const upd = await c.query(
        "UPDATE leads SET incoming=false, pipeline_id=$2, stage_id=$3 WHERE id=$1 RETURNING *",
        [leadId, pipelineId, stageId],
      );
      await writeAudit(c, ctx, { entity: "incoming_lead", entityId: leadId, action: "accepted", after: upd.rows[0], before });
      return { status: 200 as const, body: upd.rows[0] };
    }
    const upd = await c.query(
      "UPDATE leads SET incoming=false, outcome='declined', closed_at=now() WHERE id=$1 RETURNING *",
      [leadId],
    );
    await writeAudit(c, ctx, { entity: "incoming_lead", entityId: leadId, action: "declined", after: upd.rows[0], before });
    return { status: 200 as const, body: upd.rows[0] };
  });
  if (result.status === 404) return { status: 404, body: { error: "incoming_lead_not_found" } };
  if (result.status === 409) return { status: 409, body: { error: (result as { error: string }).error } };
  await enqueueAndDeliver(pool, ctx.tenantId, "lead.updated", result.body as Record<string, unknown>);
  return result as HandlerResult;
}
