/**
 * Live probe — hybrid RAG retrieval (spec §1.1 F1+F2).
 * Runs a real query against turicks_brain (Ollama embed + pgvector + keyword,
 * fused with RRF) and prints what the agent would see. Requires a populated DB
 * (`pnpm brain:sync`) and Ollama up with the embed model pulled.
 *
 *   npx tsx --env-file=.env scripts/probe-rag.ts "why did we choose LangGraph"
 *
 * To prove the F1 keyword FALLBACK, stop Ollama and re-run: the result should
 * still return matches, prefixed with a "Semantic search unavailable" banner
 * (keyword-only, degraded) instead of zero results.
 */

import { searchTuricksBrainTool } from "../src/tools/rag.js";

async function main() {
  const query = process.argv.slice(2).join(" ").trim() || "what is our ICP";
  console.log(`probe-rag: querying turicks_brain for "${query}"\n`);

  const res = await searchTuricksBrainTool.execute({ query, top_k: 5 });

  if (!res.success) {
    console.error("probe-rag: FAILED —", res.error);
    process.exit(1);
  }

  const data = String(res.data ?? "");
  console.log(data);

  const degraded = /semantic search unavailable/i.test(data);
  const hybrid = /, hybrid\)/.test(data);
  console.log(
    `\nprobe-rag: OK — mode=${degraded ? "keyword-fallback (Ollama down)" : hybrid ? "hybrid (vector+keyword)" : "single-path"}.`,
  );
  if (degraded) {
    console.log("  (Ollama appears down — this is the F1 fallback working: keyword results, not zero.)");
  }
}

main().catch((err) => {
  console.error("probe-rag: threw —", err);
  process.exit(1);
});
