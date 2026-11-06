/*
 * Knotwire — GNU AGPL-3.0-only. See LICENSE in the repository root.
 * Independent implementation. No code from Kommo/amoCRM was used.
 *
 * PostgreSQL access layer: pool, migrations, transaction-scoped tenant RLS.
 * Every request runs inside a transaction that sets `app.tenant_id` via
 * `SET LOCAL` — this is what the row-level security policies evaluate.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type QueryResult = pg.QueryResult;

export function connect(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Apply pending *.sql migrations in filename order; records in knotwire_migrations. */
export async function applyMigrations(
  pool: pg.Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS knotwire_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const { rowCount } = await pool.query("SELECT 1 FROM knotwire_migrations WHERE name = $1", [
      file,
    ]);
    if (rowCount && rowCount > 0) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO knotwire_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

/** Run fn(client) inside BEGIN with SET LOCAL app.tenant_id; commits on success. */
export async function withTenant<T>(
  pool: pg.Pool,
  tenantId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
