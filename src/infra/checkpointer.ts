/**
 * FounderOS — LangGraph Checkpointer
 * =====================================
 * PostgresSaver singleton — initialized once, reused across all runs.
 * Creates LangGraph checkpoint tables on first boot via setup().
 *
 * Usage:
 *   const saver = await getCheckpointer();
 *   const graph = myGraph.compile({ checkpointer: saver });
 */

import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { getPgPool } from "../db/client.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "checkpointer" });

// ── Singleton ─────────────────────────────────────────────────────────────────

let _saver: PostgresSaver | undefined;

/**
 * Get (or initialize) the PostgresSaver singleton.
 * First call runs setup() to ensure checkpoint tables exist.
 */
export async function getCheckpointer(): Promise<PostgresSaver> {
  if (_saver) return _saver;

  const dbUrl = process.env["DATABASE_URL"];
  if (!dbUrl) {
    throw new Error(
      "DATABASE_URL is not set.\n" +
      "Fix: add DATABASE_URL=postgresql://turicks:turicks@localhost:5432/turicks to .env"
    );
  }

  // Detect common misconfiguration: postgres user doesn't exist in the Docker container.
  // The container only has the 'turicks' user.
  if (dbUrl.includes("://postgres:") || dbUrl.startsWith("postgresql://postgres@")) {
    throw new Error(
      "DATABASE_URL uses 'postgres' user which does not exist in the FounderOS container.\n" +
      "Fix: change DATABASE_URL in .env to:\n" +
      "  DATABASE_URL=postgresql://turicks:turicks@localhost:5432/turicks"
    );
  }

  void getPgPool(); // ensure pool is warmed — not used by PostgresSaver directly
  _saver = PostgresSaver.fromConnString(dbUrl, { schema: "agents" });

  try {
    await _saver.setup();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["NODE_ENV"] !== "production") {
      log.warn({ err: msg }, "Postgres unreachable — falling back to MemorySaver for local development");
      const { MemorySaver } = await import("@langchain/langgraph");
      return new MemorySaver() as unknown as PostgresSaver;
    }
    throw new Error(
      `LangGraph checkpointer setup failed: ${msg}\n` +
      "Check that PostgreSQL is running and DATABASE_URL credentials are correct.\n" +
      "Expected: DATABASE_URL=postgresql://turicks:turicks@localhost:5432/turicks"
    );
  }

  log.info("LangGraph checkpointer ready");
  return _saver;
}

// ── Thread Reset ──────────────────────────────────────────────────────────────

/**
 * Wipe all LangGraph checkpoint history for a single thread.
 *
 * Thread IDs are stable per chat, so the checkpointer accumulates the whole
 * conversation indefinitely — old turns get replayed every message, which both
 * inflates token cost and can poison behaviour (e.g. the model staying
 * consistent with a stale earlier refusal). This clears that thread's rows so
 * the next message starts from a clean slate.
 *
 * @returns total number of rows deleted across the checkpoint tables
 */
export async function clearThreadCheckpoints(threadId: string): Promise<number> {
  const pool = getPgPool();
  // PostgresSaver-managed tables (not Drizzle). Order doesn't matter — all
  // scoped by thread_id. A missing table is tolerated (skip + continue).
  const tables = ["agents.checkpoints", "agents.checkpoint_blobs", "agents.checkpoint_writes"];
  let deleted = 0;
  for (const table of tables) {
    try {
      const res = await pool.query(
        `DELETE FROM ${table} WHERE thread_id = $1`,
        [threadId],
      );
      deleted += res.rowCount ?? 0;
    } catch (err) {
      log.warn(
        { table, err: err instanceof Error ? err.message : String(err) },
        "clearThreadCheckpoints: skipping table",
      );
    }
  }
  log.info({ threadId, deleted }, "Thread checkpoints cleared");
  return deleted;
}

// ── TTL Sweep (P0: bound unbounded checkpoint growth) ───────────────────────────

/**
 * Delete checkpoints for threads that have been idle longer than `maxAgeDays`.
 *
 * Why: thread IDs are stable per chat, so `agents.checkpoints` grows forever —
 * one row per turn, per thread, with no expiry. Left alone this is a silent
 * storage + query-latency tax (every list/get scans an ever-larger table). This
 * sweep is the durable backstop to the per-thread /reset (clearThreadCheckpoints).
 *
 * Staleness is measured by the LATEST checkpoint's `ts` (an ISO-8601 string that
 * LangGraph always writes inside the `checkpoint` JSONB) — NOT by row insertion,
 * which Postgres doesn't track. A thread is swept only if its newest checkpoint
 * is older than the cutoff, so an active conversation is never truncated
 * mid-stream; we then reuse clearThreadCheckpoints so blobs/writes never orphan.
 *
 * Defensive: if the checkpoints table doesn't exist yet (fresh DB, setup() not
 * run) it logs and returns zeros rather than throwing — a maintenance sweep must
 * never crash the scheduler. Designed to run from infra/scheduler.ts (daily).
 *
 * @param maxAgeDays threads idle longer than this are purged. Must be > 0.
 * @returns { threads, rows } — stale threads found and total rows deleted.
 */
export async function sweepStaleCheckpoints(
  maxAgeDays: number,
): Promise<{ threads: number; rows: number }> {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`sweepStaleCheckpoints: maxAgeDays must be a positive number, got ${maxAgeDays}`);
  }
  const pool = getPgPool();

  let staleThreadIds: string[];
  try {
    // Group by thread, keep only threads whose MOST-RECENT checkpoint ts is past
    // the cutoff. Parameterized interval avoids any string interpolation in SQL.
    const res = await pool.query<{ thread_id: string }>(
      `SELECT thread_id
         FROM agents.checkpoints
        GROUP BY thread_id
       HAVING MAX((checkpoint->>'ts')::timestamptz) < NOW() - ($1 || ' days')::interval`,
      [String(maxAgeDays)],
    );
    staleThreadIds = res.rows.map((r) => r.thread_id);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), maxAgeDays },
      "sweepStaleCheckpoints: could not list stale threads (table missing?) — skipping",
    );
    return { threads: 0, rows: 0 };
  }

  let rows = 0;
  for (const threadId of staleThreadIds) {
    rows += await clearThreadCheckpoints(threadId);
  }
  log.info({ threads: staleThreadIds.length, rows, maxAgeDays }, "Stale checkpoint sweep complete");
  return { threads: staleThreadIds.length, rows };
}

// Thread IDs are constructed directly in telegram.ts: `${TENANT}:${chatId}`
// (no extra layer needed for single-tenant Telegram bot)
