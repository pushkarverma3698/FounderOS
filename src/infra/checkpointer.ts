/**
 * FounderOS — Tenant-Aware LangGraph Checkpointer
 * ==================================================
 * Wraps PostgresSaver with:
 *  1. Namespaced thread IDs: {tenant_id}:{user_id}:{run_id}
 *  2. Singleton saver — initialized once, reused across all runs
 *  3. Setup helper — creates LangGraph checkpoint tables if missing
 *
 * Usage:
 *   const saver = await getCheckpointer();
 *   const graph = mainGraph.compile({ checkpointer: saver });
 *   const config = buildThreadConfig("turicks", "telegram:123456", "run-uuid");
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
  _saver = PostgresSaver.fromConnString(dbUrl);

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

// ── Thread Namespace ──────────────────────────────────────────────────────────

/**
 * Construct a namespaced thread ID.
 *
 * Format: {tenant_id}:{user_id}:{run_id}
 *
 * Examples:
 *   "turicks:telegram:1234567890:run-abc123"  ← Telegram user
 *   "turicks:scheduler:social_handler:run-xyz" ← Cron-triggered run
 */
export function buildThreadId(
  tenantId: string,
  userId: string,
  runId: string,
): string {
  return `${tenantId}:${userId}:${runId}`;
}

/**
 * LangGraph RunnableConfig for a specific thread.
 * Pass this as the `config` argument to graph.invoke() / stream().
 */
export function buildThreadConfig(
  tenantId: string,
  userId: string,
  runId: string,
  metadata: Record<string, string> = {},
): { configurable: { thread_id: string; [key: string]: unknown } } {
  return {
    configurable: {
      thread_id: buildThreadId(tenantId, userId, runId),
      ...metadata,
    },
  };
}

/**
 * Parse a namespaced thread_id back into its parts.
 * Returns null if the format is unexpected.
 */
export function parseThreadId(
  threadId: string,
): { tenantId: string; userId: string; runId: string } | null {
  const parts = threadId.split(":");
  if (parts.length < 3) return null;
  const [tenantId, ...rest] = parts;
  const runId = rest.pop()!;
  const userId = rest.join(":");
  return { tenantId: tenantId!, userId, runId };
}
