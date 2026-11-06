/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { verifyToken, type Role } from "@knotwire/core";

export interface RequestContext {
  tenantId: string;
  userId: string;
  role: Role;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, status: number, code: string, message?: string): void {
  sendJson(res, status, { error: code, message: message ?? code });
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > limitBytes) throw new Error("payload_too_large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson(
  req: IncomingMessage,
  limitBytes = 1024 * 1024,
): Promise<Record<string, unknown>> {
  const raw = await readBody(req, limitBytes);
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("invalid_json");
  }
}

const ROLES = new Set<Role>(["admin", "manager", "agent", "readonly"]);

export function authenticate(req: IncomingMessage, jwtSecret: string): RequestContext | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const claims = verifyToken(header.slice("Bearer ".length), jwtSecret);
    if (!ROLES.has(claims.role as Role)) return null;
    return { tenantId: claims.tenantId, userId: claims.sub, role: claims.role as Role };
  } catch {
    return null;
  }
}

export function requireWriteRole(ctx: RequestContext): boolean {
  return ctx.role !== "readonly";
}

export function requireManagerRole(ctx: RequestContext): boolean {
  return ctx.role === "admin" || ctx.role === "manager";
}
