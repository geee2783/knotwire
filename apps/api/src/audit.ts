/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 */

import type pg from "pg";
import type { RequestContext } from "./context.js";

export type AuditAction = "created" | "updated" | "deleted" | "stage_changed" | "accepted" | "declined" | "tested";

export interface AuditInput {
  entity: string;
  entityId: string | null;
  action: AuditAction;
  before: unknown;
  after: unknown;
}

export async function writeAudit(client: pg.PoolClient, ctx: RequestContext, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, entity, entity_id, action, actor_kind, actor_id, before, after)
     VALUES ($1, $2, $3, $4, 'user', $5, $6, $7)`,
    [
      ctx.tenantId,
      input.entity,
      input.entityId,
      input.action,
      ctx.userId,
      input.before === undefined || input.before === null ? null : JSON.stringify(input.before),
      input.after === undefined || input.after === null ? null : JSON.stringify(input.after),
    ],
  );
}
