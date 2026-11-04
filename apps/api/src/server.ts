/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * M0 HTTP surface: health and readiness. Grows in M1 (leads/contacts REST) and
 * M6 (public API: OAuth2, webhooks, OpenAPI, Tailscale Serve profile).
 */

import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

export interface ApiOptions {
  port?: number;
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function createApi(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, { status: "ok", service: "knotwire-api" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/readyz") {
      // Infra checks (Postgres, Redis) wire in during M1/M2.
      json(res, 200, { status: "ready", note: "infra wiring lands in M1" });
      return;
    }
    json(res, 404, { error: "not_found" });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env["PORT"] ?? 8080);
  createApi().listen(port, () => {
    // eslint-disable-next-line no-console -- bootstrap log
    console.log(`knotwire-api listening on :${port}`);
  });
}
