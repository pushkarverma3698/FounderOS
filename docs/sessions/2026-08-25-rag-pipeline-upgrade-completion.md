# 2026-08-25 — RAG pipeline upgrade: closing out the remaining 3 commits

## What we did

Finished the 5-commit plan in `docs/plans/2026-07-27-rag-pipeline-upgrade-design.md`.
Commits 1 (retrieval eval harness) and 3 (markdown-heading chunking) had already
shipped separately (AG-010, PR #577). This session did the remaining three:

- **Commit 2** — unified `search_knowledge` onto the same hybrid (vector ⊕
  keyword, RRF-fused) engine `search_turicks_brain` already used, instead of a
  separate ILIKE-only path over `knowledge_entries`. Relocated the shared engine
  from `src/tools/rag.ts` into `src/db/rag-query.ts` (`runRagSearch`) and the
  tool-rendering helpers into `src/db/retrieval-result.ts`, so no tool imports
  from another tool. Added a bound-param `entry_type` filter, forgiving (retries
  unfiltered on a zero-hit filtered search) to preserve the 2026-06-15
  anti-hallucination guard. Deleted `setKnowledgeEmbedding` (73 wasted Ollama
  calls per `brain:sync`, writing a column nothing read). Collapsed research.ts's
  "call both tools" instruction to one call (sales.ts/marketing.ts never
  actually said this, despite the plan estimating 6 prompt files).
- **Commit 4** — added a 4th ablation lane (`hybrid+rerank`) to
  `scripts/run-retrieval-eval.ts` plus p95 latency instrumentation, since the
  harness had no way to measure rerank's effect before this (it never called
  `rerankHits` regardless of `RAG_RERANK`) and no latency measurement at all.
  Measured against the live dev corpus; see Metrics.
- **Commit 5** — this file, `docs/sessions/TEMPLATE.md`, and the CLAUDE.md rule
  naming the mechanism explicitly.

## What we fixed

- `docs/sessions/*.md` walker (`scripts/sync-turicks-brain.ts`, shipped in PR
  #577) would have ingested `TEMPLATE.md` itself as a blank "session" entry on
  every sync — it only filtered on `.endsWith(".md")`. Extracted `isSessionLogFile`
  (excludes `TEMPLATE.md` by name) and unit-tested it, mirroring the existing
  `isPlanSyncSource` pattern.
- A second, previously undiscovered stale test file
  (`tests/unit/tools/context-knowledge.test.ts`, "Phase C") had its own
  `searchKnowledge` suite testing the pre-unification routing directly against
  `searchKnowledgeEntries`/`getKnowledgeByType` — would have failed the moment
  commit 2 landed. Deleted that block; its unrelated `readContext`/`updateContext`
  coverage was untouched.
- A real, pre-existing call-shape regression surfaced during implementation: an
  early version of the `runRagSearch` relocation always forwarded a 4th `opts`
  argument (even `undefined`) to `searchRagTable`/`keywordSearchRagTable`, which
  broke `rag.test.ts`'s exact `toHaveBeenCalledWith(table, vec, topK)` assertions
  for the three untouched RAG tools (an explicit `undefined` 4th arg is not the
  same call as 3 args to `toHaveBeenCalledWith`). Fixed by only forwarding `opts`
  when actually set.

## Why

PR #577's own audit found `search_knowledge` and `search_turicks_brain` were two
retrieval paths over the same 73 documents, with prompts telling agents to call
both "just in case" — belt-and-braces for an ambiguity, not a real reason for two
paths. Commit 2 removes the duplication at the source instead of the symptom.
Commit 4 exists because rerank had been sitting behind a flag, unmeasured, since
before this plan — "enabled by feel, not evidence" per the plan's own framing;
measuring it once, by a rule fixed before seeing the numbers, is what turns that
into a decision instead of a guess. Commit 5 exists because CLAUDE.md's old
"significant decisions → episodic memory" line had no destination and no
mechanism — a rule nobody can act on doesn't get followed twice (CLAUDE.md
rule #27).

## Metrics

Retrieval ablation, live dev corpus (`turicks-postgres`, 3630 chunks / 122 docs),
`pnpm eval:retrieval`, 37 golden cases:

| lane | recall@5 | MRR | p95 |
|---|---|---|---|
| hybrid (production today) | 83.8% | 0.797 | 575ms |
| vector-only | 81.1% | 0.748 | 65ms |
| keyword-only | 70.3% | 0.676 | 534ms |
| hybrid+rerank (llama3.2:3b, top-20 pool) | 81.1% | 0.752 | 8584ms |

Rerank decision: **no change** — hybrid+rerank is -2.7pp on recall@5 (a
regression, not an improvement) and p95 is ~2.9x over the 3s cap. Both
conditions in the fixed decision rule fail.

One golden case (`rca-prod-hardcore-qa`) scores 0% in every lane because its
expected document, `docs/study/RCA-2026-07-01-prod-hardcore-qa.md`, does not
exist in this worktree (confirmed via `find`, not a sync gap) — a pre-existing
golden-set/corpus mismatch from AG-010, affecting all 4 lanes identically so it
does not bias the rerank comparison above.

Verification: `pnpm lint` clean, `pnpm test` green (328 files / 3619 tests)
after each commit. `pnpm gate` run once at the end covering all three commits
together.

## Outstanding

- The `rca-prod-hardcore-qa` golden case's missing document — either the file
  was renamed/moved after the golden set was authored, or it should be removed
  from `src/eval/retrieval-golden.ts`. Not investigated further; out of scope
  for this session.
- `search_turicks_brain`/`search_personal_rag`/`search_research_cache` declare a
  `doc_type` filter in their Zod schema that `execute()` never reads or
  forwards — found during commit 2, explicitly deferred rather than fixed
  (kept this change scoped to what was asked).
- The two constants above are the two items flagged as separate follow-up
  tasks at the end of this session (see the session's final message for
  exact task descriptions).
