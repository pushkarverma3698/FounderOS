/**
 * FounderOS — Weekly RAG & Database Optimization Sweep
 * ======================================================
 *   - Runs once a week (Sundays 3am UTC).
 *   - Inspects RAG vector health (embedding coverage, unembedded entries).
 *   - Reports to Telegram.
 *
 * The invariant this file exists to hold: **a check that did not run and a check
 * that came back clean must never look the same from outside.** A DB outage used
 * to render "✅ RAG vector database is optimal" — a confident all-clear produced
 * by the failure path. So must an EMPTY store: zero chunks is not 100% coverage,
 * it is nothing to cover. Both are reported as what they are.
 */

import { sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sendToChat } from "./telegram-send.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "rag-optimization" });

export interface RagHealthReport {
  totalChunks: number;
  nullEmbeddings: number;
  unindexedEntries: number;
  coveragePercent: number;
}

/**
 * Either real numbers, or the reason there are none. Encoding the failure in the
 * return type is what makes it impossible for a caller to render an outage as health.
 */
export type RagHealthResult =
  | { readonly ok: true; readonly report: RagHealthReport }
  | { readonly ok: false; readonly reason: string };

/** Escape for Telegram `parse_mode: "HTML"` — DB error text is not markup. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Collector: assess pgvector & RAG database health. Never throws; reports why instead. */
export async function inspectRagHealth(): Promise<RagHealthResult> {
  const db = getDb();
  try {
    const res = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM brain.brain_memories)::int AS total_chunks,
        (SELECT count(*) FROM brain.brain_memories WHERE embedding IS NULL)::int AS null_embeddings,
        (SELECT count(*) FROM brain.knowledge_entries WHERE embedding IS NULL)::int AS unindexed_entries;
    `);

    const row = (
      res as unknown as Array<{
        total_chunks: number;
        null_embeddings: number;
        unindexed_entries: number;
      }>
    )[0];

    if (!row) {
      return { ok: false, reason: "health query returned no rows" };
    }

    const total = row.total_chunks ?? 0;
    const nulls = row.null_embeddings ?? 0;
    const unindexed = row.unindexed_entries ?? 0;

    return {
      ok: true,
      report: {
        totalChunks: total,
        nullEmbeddings: nulls,
        unindexedEntries: unindexed,
        coveragePercent: total > 0 ? Math.round(((total - nulls) / total) * 100) : 0,
      },
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Pure renderer — the whole point of the split is that this is testable with no DB. */
export function renderRagReport(result: RagHealthResult): string {
  const title = `🧠 <b>Weekly RAG & Database Health</b>`;

  if (!result.ok) {
    return [
      title,
      ``,
      `⚠️ <b>The check DID NOT RUN.</b> This is not a clean result, it is no result.`,
      `Reason: <code>${escapeHtml(result.reason)}</code>`,
      ``,
      `<i>Vector coverage is UNKNOWN this week — not verified as healthy.</i>`,
    ].join("\n");
  }

  const { totalChunks, nullEmbeddings, unindexedEntries, coveragePercent } = result.report;

  if (totalChunks === 0) {
    return [
      title,
      ``,
      `⚠️ <b>The vector store is EMPTY</b> — 0 chunks in <code>brain.brain_memories</code>.`,
      `Nothing can be retrieved. This is a failure of ingestion, not of coverage.`,
      ``,
      `<i>Run <code>pnpm brain:sync</code> to populate it.</i>`,
    ].join("\n");
  }

  const pending = nullEmbeddings + unindexedEntries;
  const action =
    pending > 0
      ? `⚠️ <i>${pending} item(s) are stored but NOT embedded, so they are invisible to search. ` +
        `The nightly <code>pnpm brain:sync</code> (2am UTC) re-embeds them — if this number does not ` +
        `fall by next Sunday, the sync is failing.</i>`
      : `✅ <i>Every stored chunk is embedded and retrievable.</i>`;

  return [
    title,
    ``,
    `• Total Vector Chunks: <b>${totalChunks}</b>`,
    `• Embedding Coverage: <b>${coveragePercent}%</b>`,
    `• Unembedded Chunks: <b>${nullEmbeddings}</b>`,
    `• Unembedded Knowledge Entries: <b>${unindexedEntries}</b>`,
    ``,
    action,
  ].join("\n");
}

/** Weekly scheduled job: inspect RAG health and report it. */
export async function runRagOptimizationSweep(): Promise<void> {
  log.info("Starting weekly RAG optimization sweep...");
  const result = await inspectRagHealth();

  if (!result.ok) {
    log.error({ reason: result.reason }, "RAG health inspect failed — reporting as NOT RUN");
  }

  await sendToChat(renderRagReport(result), "HTML");
  log.info({ result }, "Weekly RAG health report sent to Telegram");
}
