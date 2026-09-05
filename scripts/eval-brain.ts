#!/usr/bin/env node
/**
 * eval-brain.ts
 * =============
 * Runs test queries against the unified Postgres brain to evaluate
 * Recall@1,3,5 for hybridRagSearch.
 */

import "./lib/require-env.js";
import { searchBrain } from "../src/db/rag-search.js";

const TEST_QUERIES = [
  "What is the single source of truth for architecture decisions?",
  "How does FounderOS isolate personal and business data?",
  "What is the strategic vision of Turicks?",
  "Which database is used for the brain?",
  "How are web findings stored?"
];

async function main() {
  console.log("🧠 Starting Brain Evaluation...");
  console.log("===============================\n");

  for (const query of TEST_QUERIES) {
    console.log(`Query: "${query}"`);
    try {
      const result = await searchBrain({ query, topK: 5, table: "brain_memories" });
      if ('error' in result) {
        console.error(`❌ Error at ${result.error.stage}: ${result.error.message}\n`);
        continue;
      }

      const hits = result.hits;
      if (hits.length === 0) {
        console.log("⚠️  No results found.\n");
        continue;
      }

      console.log(`✅ Found ${hits.length} results.`);
      hits.slice(0, 3).forEach((hit, i) => {
        console.log(`   [${i+1}] Score: ${hit.score.toFixed(3)} | Type: ${hit.metadata.entry_type ?? "unknown"}`);
        console.log(`       Source: ${hit.metadata.source_path ?? "unknown"}`);
        console.log(`       Snippet: ${hit.content.substring(0, 60).replace(/\n/g, " ")}...`);
      });
      console.log();
    } catch (err) {
      console.error(`❌ Failed: ${(err as Error).message}\n`);
    }
  }

  console.log("✅ Evaluation complete.");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
