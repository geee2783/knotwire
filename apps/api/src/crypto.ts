/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * AES-256-GCM field encryption for wa_ids and channel tokens.
 * Master key from KNOTWIRE_MASTER_KEY (base64, exactly 32 bytes).
 * Per-tenant envelope keys are a documented post-v1 hardening step.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

function masterKey(): Buffer {
  const secret = process.env["KNOTWIRE_MASTER_KEY"];
  if (secret) {
    const key = Buffer.from(secret, "base64");
    if (key.length !== 32) throw new Error("KNOTWIRE_MASTER_KEY must be base64 of exactly 32 bytes");
    return key;
  }
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("KNOTWIRE_MASTER_KEY must be set in production");
  }
  // Deterministic dev-only key (fixed string hashed). NEVER for production.
  return createHash("sha256").update("knotwire-dev-master-key-change-me").digest();
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${ct.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptField(payload: string): string {
  const [version, ivB64, ctB64, tagB64] = payload.split(":");
  if (version !== "v1" || !ivB64 || !ctB64 || !tagB64) throw new Error("malformed encrypted field");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
}

/** Non-reversible lookup key for encrypted identity fields (wa_id dedupe). */
export function hashIdentity(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
