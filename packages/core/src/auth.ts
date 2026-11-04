/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * Minimal HS256 JWT (RFC 7519) issue/verify using node:crypto only.
 * Production hardening (RS256/KMS keys, rotation) is tracked in the
 * threat model (docs/threat-model/v0.md) and lands in M1.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface TokenClaims {
  sub: string;
  tenantId: string;
  role: string;
  iat: number;
  exp: number;
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString("base64url");

const b64urlJson = (value: unknown): string =>
  b64url(Buffer.from(JSON.stringify(value), "utf8"));

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function issueToken(
  claims: Omit<TokenClaims, "iat" | "exp">,
  secret: string,
  ttlSeconds = 3600,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({ ...claims, iat: now, exp: now + ttlSeconds });
  const body = `${header}.${payload}`;
  return `${body}.${sign(body, secret)}`;
}

export function verifyToken(token: string, secret: string): TokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [header, payload, sig] = parts as [string, string, string];
  const body = `${header}.${payload}`;
  const expected = sign(body, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("invalid signature");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new Error("token expired");
  }
  if (!claims.sub || !claims.tenantId || !claims.role) {
    throw new Error("missing required claims");
  }
  return claims;
}
