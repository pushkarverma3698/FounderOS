/**
 * FounderOS — Database Client
 * ============================
 * Two connection singletons:
 *  - `db`   Drizzle ORM instance (postgres.js driver) — for all application queries
 *  - `pool` pg.Pool instance — passed to LangGraph PostgresSaver checkpointer
 *
 * Both are initialized lazily and reused across the process lifetime.
 * Call `closeDatabaseConnections()` during graceful shutdown.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import pg from "pg";
import { env } from "../core/config.js";
import * as schema from "./schema.js";

// ── postgres.js client (Drizzle queries) ──────────────────────────────────────

let _sqlClient: ReturnType<typeof postgres> | undefined;
let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

function getSqlClient(): ReturnType<typeof postgres> {
  if (!_sqlClient) {
    _sqlClient = postgres(env.DATABASE_URL, {
      max: 10,          // connection pool size — sufficient for startup scale
      idle_timeout: 30, // seconds before idle connection is closed
      connect_timeout: 10,
    });
  }
  return _sqlClient;
}

/** Drizzle ORM instance — use for all application queries. */
export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) {
    _db = drizzle(getSqlClient(), { schema });
  }
  return _db;
}

/** Convenience export — same as `getDb()` but shorter. */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return getDb()[prop as keyof ReturnType<typeof drizzle<typeof schema>>];
  },
});

// ── pg.Pool (LangGraph checkpointer) ─────────────────────────────────────────

let _pool: pg.Pool | undefined;

/**
 * pg.Pool for LangGraph PostgresSaver.
 * Separate from Drizzle client — checkpointer manages its own transactions.
 *
 * Pool sizing: min:5, max:20 — right-sized for a startup; scale later.
 */
export function getPgPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      min: 5,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    _pool.on("error", (err) => {
      // Log but don't crash — pool will recover
      console.error("[db:pool] Unexpected pg pool error:", err.message);
    });
  }
  return _pool;
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

/** Call during SIGTERM to drain connections cleanly. */
export async function closeDatabaseConnections(): Promise<void> {
  const tasks: Promise<unknown>[] = [];

  if (_sqlClient) {
    tasks.push(_sqlClient.end({ timeout: 5 }));
    _sqlClient = undefined;
    _db = undefined;
  }

  if (_pool) {
    tasks.push(_pool.end());
    _pool = undefined;
  }

  await Promise.allSettled(tasks);
}
