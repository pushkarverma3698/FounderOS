/**
 * Collector for the cross-source and no-answer retrieval cases (AG-029). All I/O lives here; scoring is in
 * src/eval/retrieval-cross-source.ts. Runs the same hybrid path production uses. $0: local embeddings only.
 */
import { sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { hybridRagSearch, type HybridDeps } from "../../src/db/rag-hybrid.js";
import type { RagHit } from "../../src/db/rag-search.js";
import { RETRIEVAL_TOP_K } from "../../src/eval/retrieval-scoring.js";
import { RETRIEVAL_NO_ANSWER_CASES } from "../../src/eval/retrieval-no-answer.js";
import {
  CROSS_SOURCE_CASES,
  renderExtraReport,
  scoreCrossSourceCase,
  scoreNoAnswerCase,
  countExtraFailures,
  type CrossSourceResult,
  type NoAnswerResult,
} from "../../src/eval/retrieval-cross-source.js";

export interface ExtraOutcome {
  readonly report: string;
  readonly failures: number;
}

async function countOrigin(origin: string): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM brain.brain_memories WHERE status = 'ACTIVE' AND metadata->>'origin' = ${origin}`,
  )) as unknown as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/** Hits for a query, or null when retrieval itself failed (reported as a failure, never as an abstain). */
async function search(deps: HybridDeps, query: string): Promise<RagHit[] | null> {
  const result = await hybridRagSearch("brain_memories", query, RETRIEVAL_TOP_K, deps);
  return "error" in result ? null : result.hits;
}

export async function runExtraCases(deps: HybridDeps): Promise<ExtraOutcome> {
  const cross: CrossSourceResult[] = [];
  for (const c of CROSS_SOURCE_CASES) {
    try {
      const rows = await countOrigin(c.origin);
      const hits = c.expectContains === null ? [] : ((await search(deps, c.query)) ?? []);
      cross.push(scoreCrossSourceCase(c, hits, rows, RETRIEVAL_TOP_K));
    } catch (err) {
      cross.push({ goldenCase: c, verdict: "fail", detail: `The query errored: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const noAnswer: NoAnswerResult[] = [];
  for (const c of RETRIEVAL_NO_ANSWER_CASES) {
    try {
      const hits = await search(deps, c.query);
      noAnswer.push(
        hits === null
          ? { goldenCase: c, abstained: false, detail: "Retrieval failed, so the abstain could not be checked." }
          : scoreNoAnswerCase(c, hits),
      );
    } catch (err) {
      noAnswer.push({ goldenCase: c, abstained: false, detail: `The query errored: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { report: renderExtraReport(cross, noAnswer), failures: countExtraFailures(cross, noAnswer) };
}
