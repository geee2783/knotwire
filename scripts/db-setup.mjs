/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation.
 * Independent implementation.
 *
 * One-time database bootstrap for development/CI. Creates (or reuses) the
 * least-privilege application role used by the API, and applies migrations.
 * RLS is enforced against this role, not the superuser.
 *
 * Usage:
 *   SUPERUSER_DATABASE_URL=postgres://postgres:pw@127.0.0.1:5432/knotwire \
 *   APP_ROLE_PASSWORD=knotwire-app-pw \
 *   node scripts/db-setup.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, "..", "packages", "core", "migrations");

const adminUrl = process.env["SUPERUSER_DATABASE_URL"];
const rolePassword = process.env["APP_ROLE_PASSWORD"] ?? "knotwire-app-pw";

if (!adminUrl) {
  console.error("SUPERUSER_DATABASE_URL is required (e.g. postgres://postgres@127.0.0.1:5432/knotwire)");
  process.exit(1);
}
if (rolePassword.includes("'")) {
  console.error("APP_ROLE_PASSWORD must not contain a single quote");
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();

// Create least-privilege role if missing
await client.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knotwire_app') THEN
      CREATE ROLE knotwire_app LOGIN PASSWORD '${rolePassword}';
    END IF;
  END
  $$;
`);

// Grants on current objects and defaults for future ones
await client.query(`GRANT USAGE ON SCHEMA public TO knotwire_app`);
await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO knotwire_app`);
await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO knotwire_app`);
await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knotwire_app`);
await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO knotwire_app`);

// Apply migrations (superuser can read files)
await client.query(
  "CREATE TABLE IF NOT EXISTS knotwire_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
);
const files = readdirSync(migrationsDir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
for (const file of files) {
  const { rowCount } = await client.query("SELECT 1 FROM knotwire_migrations WHERE name = $1", [file]);
  if (rowCount && rowCount > 0) continue;
  const sql = readFileSync(join(migrationsDir, file), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO knotwire_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log("applied", file);
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`migration ${file} failed: ${(err).message}`);
  }
}

// Ensure tenants table exists (idempotent; needed before role grants on it)
console.log("db setup complete: role knotwire_app ready; migrations applied");
await client.end();
