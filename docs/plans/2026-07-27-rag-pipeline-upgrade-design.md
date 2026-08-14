# RAG Pipeline Upgrade — Design

**Date:** 2026-07-27
**Status:** Approved (design), pending plan
**Trigger:** `/deep-research` audit of the RAG pipeline (2026-07-27), followed by user directive to fix all findings in one verified PR.

## Context

Audit findings on the current pipeline (`src/db/rag-hybrid.ts`, `src/db/rag-search.ts`, `src/db/rrf.ts`, `src/db/rag-rerank.ts`, `src/tools/rag.ts`, `src/tools/knowledge.ts`, `scripts/sync-turicks-brain.ts`):

1. No retrieval-quality eval exists. `src/eval/` (`pnpm eval`) tests routing/tool-calling on a live model — it never scores whether retrieval returns the right chunks. Changes to chunking, RRF, or rerank ship with zero measurement.
2. `search_knowledge` (over `knowledge_entries`, keyword ILIKE only) and `search_turicks_brain` (hybrid vector+keyword+RRF over `turicks_brain`) are two separate retrieval paths over overlapping content. Verified: `turicks_brain`'s 73 distinct `source_path` values are an exact match for the 73 current `knowledge_entries` docs — the split is not covering different content, it's duplicated indexing. Agent prompts compensate by instructing "call both," which is belt-and-braces for the ambiguity, not a real reason to keep two paths.
3. `knowledge_entries.embedding` is written at 3 call sites in `scripts/sync-turicks-brain.ts` (`setKnowledgeEmbedding`, line 276) and read nowhere — confirmed by grep across the repo. 73 wasted Ollama embed calls every `brain:sync` run.
4. `chunkText` (`src/lib/embed.ts`) is length-based only (1800 chars, 200 overlap, soft-breaks on `\n\n`/`. `/`\n`). It has no awareness of markdown structure, so a chunk boundary can fall mid-section and a chunk carries no heading context.
5. Rerank (`src/db/rag-rerank.ts`, `qwen2.5:7b` via Ollama, $0) exists and is wired in, but its actual effect on hit rate has never been measured against the real corpus — enabled by feel, not evidence.
6. No mechanism writes session-level work (what was done, what was fixed, why, metrics) anywhere retrievable. CLAUDE.md already has a "significant decisions → episodic memory" rule, but `record_event` is an HITL-gated agent tool only callable inside a live Telegram turn — there is no path from a Claude Code dev session into that store. The rule has no mechanism, which is why it hasn't stuck.

Resolved before designing (no further discovery needed):
- `personal_rag`'s small size is not a bug — its 5.8KB source produces exactly 4 chunks. Correct behavior on a tiny corpus. **Out of scope this round** (user: "skip it entirely").
- 43MB of un-ingested PDFs sit in `raw_docs/` (70 Google-Drive-ID directories) — noted, **out of scope this round**.
- Retrieval eval cannot be a CI gate: `.github/workflows/ci.yml` has no `services:` block (no Postgres, no Ollama in CI). It runs on demand only.

## Decisions

| Question | Decision |
|---|---|
| PR packaging | One PR, five commits, each independently testable and revertable |
| `personal_rag` gap | Skip — out of scope |
| Retrieval eval placement | `pnpm eval:retrieval`, on-demand only (not CI) |
| `search_knowledge` vs `search_turicks_brain` | Unify onto one engine; keep both tool names (MCP contract + prompt stability) |
| `knowledge_entries` table | Keep as the versioned system-of-record; stop writing embeddings to it |
| Session logging mechanism | `docs/sessions/*.md` walked into `brain:sync`, not a live-turn tool call |
| Rerank keep/drop | Evidence-gated: measure, decide by a fixed rule, ship the outcome either way |

## Design — 5 commits, 1 PR

### Commit 1 — `feat(eval): retrieval golden-set harness`

New, additive, zero behavior change to production code.

- `src/eval/retrieval/fixtures.ts` — `RetrievalCase[]`: `{ id, query, store: "turicks_brain" | "research_cache", expectedSources: string[] }`. ~15–20 cases hand-picked to cover ADRs, brand, strategy, phases.
- `src/eval/retrieval/score.ts` — pure functions `hitAtK(hits, expected, k)`, `mrr(hits, expected)`, `summarize(results)`. Unit-tested, $0.
- `scripts/run-retrieval-eval.ts` — runs `runRagSearch` (the real hybrid path) for every fixture against the live dev DB, prints a table (hit@3, hit@5, MRR, p50/p95 latency) and writes JSON to `docs/sessions/` for the commit message to cite.
- `package.json`: `"eval:retrieval": "node --env-file=.env --import tsx/esm scripts/run-retrieval-eval.ts"`.
- `tests/unit/eval/retrieval-score.test.ts` — covers `hitAtK`/`mrr` edge cases (empty hits, exact match, no match).

**Fixtures assert on `metadata.source_path` only** — never chunk text or row ID — because commit 3 re-chunks the corpus and would otherwise invalidate the fixtures.

**Baseline run, recorded in the commit message** (current chunking, current rerank setting).

### Commit 2 — `refactor(rag): unify search_knowledge onto the hybrid engine`

- `src/db/rag-search.ts`: `searchRagTable` and `keywordSearchRagTable` gain `filter?: { entry_type?: string }` → adds `AND metadata->>'entry_type' = $1` (bound parameter, not string-concatenated).
- `src/tools/knowledge.ts`: `search_knowledge` keeps its exact name, description, and Zod schema (external MCP contract — `mcp__founderos__search_knowledge` — must not break). Internally it now calls `runRagSearch("turicks_brain", query, { filter: { entry_type } })` instead of `searchKnowledgeEntries`/`getKnowledgeByType`. Preserves the existing empty-result fallback message and the "do NOT fabricate" instruction verbatim (prod incident 2026-06-15 guard).
- `scripts/sync-turicks-brain.ts`: delete `setKnowledgeEmbedding` and its 3 call sites (lines ~240, 246, 270, 276). `knowledge_entries` rows are written without an embedding column touch.
- `src/db/queries.ts`: `searchKnowledgeEntries`/`getKnowledgeByType` remain (still used for direct `knowledge_entries` lookups elsewhere, e.g. admin tooling) — not deleted, just no longer the engine behind `search_knowledge`.
- 6 agent system prompts: replace "call search_knowledge AND search_turicks_brain" guidance with a single-call instruction.
- Tests: extend `tests/unit/tools/knowledge.test.ts` (mocked `runRagSearch`) to cover the delegation, the entry_type filter, and the unchanged empty-result message. Extend `tests/unit/db/rag-search.test.ts` for the new `filter` param and SQL shape.

### Commit 3 — `feat(rag): markdown-heading-aware chunking`

- `src/lib/embed.ts`: `chunkText` gets a structural pass before the existing char-split: split first on `^#{1,3}\s` boundaries, then apply the current char-limit+overlap logic only to sections that exceed `maxChars`. Each emitted chunk is prefixed with its heading trail (e.g. `"ADR-001 › Decision"`), joined with `\n\n`, before the content.
- Pure function — `tests/unit/lib/embed.test.ts` extended with heading-boundary cases (nested headings, no-heading fallback to old behavior, oversized-section split).
- Requires `pnpm brain:sync` re-run (idempotent delete+reinsert per source doc — verified existing behavior).
- Commit message records the delta: `pnpm eval:retrieval` before vs. after this commit.

### Commit 4 — `chore(rag): rerank decision`

- Run `pnpm eval:retrieval` with `RAG_RERANK=false` then `RAG_RERANK=true` (env var already read by `src/tools/rag.ts`/`shouldRerank`).
- **Decision rule, fixed before running the numbers:** enable rerank by default only if hit@5 improves by ≥3 percentage points across the fixture set AND p95 latency stays under 3s. Otherwise leave the current default unchanged.
- The commit contains only the config/default change (or a no-op if the rule says no) plus the measured numbers in the message. A "measured, didn't clear the bar, left as-is" outcome is valid and will be recorded as such — not silently dropped.

### Commit 5 — `docs: session-log rule + docs/sessions ingestion`

- `docs/sessions/TEMPLATE.md` — fixed sections: `## What we did` / `## What we fixed` / `## Why` / `## Metrics` / `## Outstanding`.
- `scripts/sync-turicks-brain.ts`: `collectDocs()` gains a walker over `docs/sessions/*.md` → `entry_type: "session"`.
- `src/tools/knowledge.ts`: `entry_type` enum gains `"session"`.
- `CLAUDE.md` lines 60–61 replaced: the old "Memory is the source of truth" bullet is expanded into a concrete end-of-session rule naming the exact path (`docs/sessions/YYYY-MM-DD-<topic>.md`), the required template, and `pnpm brain:sync` as the last step of any session that completes or merges work.
- This session's own log (retrieval-eval baseline, the unification, the chunking delta, the rerank call) is written as the first real file under `docs/sessions/`, doubling as an example and dogfooding the mechanism in the same PR.

## Testing plan

- $0 unit tests: `retrieval-score.test.ts` (new), `embed.test.ts` (extended, heading chunker), `rag-search.test.ts` (extended, filter SQL), `knowledge.test.ts` (extended, delegation).
- `pnpm gate` green before the PR is opened (lint + build + wiring + arch + test).
- Live verification (not CI, run once per commit that changes retrieval behavior): `pnpm eval:retrieval` before/after commit 3, before/after commit 4; `pnpm brain:sync` re-run after commit 3; one live Telegram query confirming `search_knowledge` still answers correctly through the new engine post-commit-2.
- No paid model calls anywhere in this work — eval harness and rerank both run on Ollama/pgvector only.

## Out of scope

- `personal_rag` corpus size / `raw_docs/` PDF ingestion (explicitly deferred by user).
- Graph RAG, query rewriting, cross-encoder reranking beyond the existing Ollama classify-based reranker (2026 best-practice items noted in the audit but not justified by current corpus size ~200 chunks).
- Making `pnpm eval:retrieval` a CI gate (no Postgres/Ollama service in CI; would require infra work not requested).

## Risks

- Re-chunking (commit 3) changes row IDs/content for every `turicks_brain` row — mitigated by fixtures asserting on `source_path`, and a mandatory `brain:sync` re-run in the same commit.
- `search_knowledge` behavior change is the highest blast-radius item (25 references across 6 prompts, MCP server contract, golden tasks) — mitigated by preserving name/schema/fallback message exactly and adding delegation tests before touching prompts.
