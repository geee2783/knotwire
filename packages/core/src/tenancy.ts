/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 */

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: Role;
}

export type Role = "admin" | "manager" | "agent" | "readonly";

export class TenantIsolationError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(`cross-tenant access blocked: expected tenant ${expected}, got ${actual}`);
    this.name = "TenantIsolationError";
    this.expected = expected;
    this.actual = actual;
  }
}

export function createTenantContext(input: {
  tenantId: string;
  userId: string;
  role?: Role;
}): TenantContext {
  const tenantId = input.tenantId.trim();
  const userId = input.userId.trim();
  if (!tenantId) throw new Error("tenantId is required");
  if (!userId) throw new Error("userId is required");
  return { tenantId, userId, role: input.role ?? "agent" };
}

/** Throws when a row belonging to another tenant is touched. */
export function assertTenant(ctx: TenantContext, rowTenantId: string): void {
  if (ctx.tenantId !== rowTenantId) {
    throw new TenantIsolationError(ctx.tenantId, rowTenantId);
  }
}

/** Roles allowed to perform privileged admin actions. */
export function canAdminister(ctx: TenantContext): boolean {
  return ctx.role === "admin";
}

/** RLS session key written by `SET LOCAL app.tenant_id = ...` in migrations. */
export const TENANT_GUC = "app.tenant_id";
