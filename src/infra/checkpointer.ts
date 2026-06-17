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

// Thread IDs are constructed directly in telegram.ts: `${TENANT}:${chatId}`
// (no extra layer needed for single-tenant Telegram bot)
