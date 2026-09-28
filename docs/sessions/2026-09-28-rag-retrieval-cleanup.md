# 2026-09-28 — RAG retrieval cleanup: one reader per table, CV questions to jobhunt

## What we did

- Executed [`docs/plans/2026-09-28-rag-retrieval-cleanup.md`](../plans/2026-09-28-rag-retrieval-cleanup.md)
  on `claude/fix-rag-retrieval-cleanup`, after merging `origin/beta` into it (merge commit, no
  rebase). Commits 1–4 landed. Commit 5, the founder card, stopped under the plan's own rule.
- Corrected the plan in place: 13 items under "Corrections found during execution", each with its
  evidence.
- Offline only. No VPS, no prod DB, no paid model call, no live eval. Everything prod-shaped is in
  Outstanding as NOT VERIFIED.

## What we fixed

1. **research made two brain searches for one question** (`68bcfa7`). `search_knowledge` and
   `search_turicks_brain` both run `runRagSearch("brain_memories", …)`. `search_knowledge` now takes
   `top_k` (1–10), the only reason the prompt gave for the second tool, and research holds one brain
   tool. The UnifiedTool stays for `scripts/probe-rag.ts` and the two VPS QA scripts.
2. **MCP `search_knowledge` ignored `limit`** (same commit). The handler passed it by a name the
   tool's schema did not have, so zod stripped it and every client got 5 results.
3. **personal answered CV questions from a 4-row June wiki stub** (`6fb7429`). `search_personal_rag`
   is gone from personal, and personal got no CV tool in exchange (the plan said `read_cv`). jobhunt
   already owns `read_cv`, its planner description claims every CV question, and the planner reads
   tool names as routing signals — a second CV route is how personal won a Tashi CV question on
   2026-09-07.
4. **Dead text** (`2180185`). research's top-priority "ROUTING OVERRIDES" keyed on two directives
   nothing has emitted since the v2 pre-router was deleted on 2026-07-08. The MCP `read_cv`
   description and `career.ts` header described the pre-2026-08-21 fallback order.
5. **The frozen `turicks_brain` table was still allowlisted** (`d4b2517`). Removed from
   `ALLOWED_RAG_TABLES`/`RagTable`; the table and its 1,352 rows are untouched.
6. **`.claude/graph.json` still showed both retired placements** (`7970272`). Regenerated offline
   from the live registry; the generator's RAG prose is corrected too.

Mechanisms, so none of this depends on a prompt rule:

- `RETRIEVAL_TOOL_TABLE` + `tests/unit/agents/retrieval-tool-table.test.ts`: fails on two readers of
  one table in a worker, on a worker tool that imports the RAG engine without a map entry, and on a
  map entry the tool does not query (engine spied). Review tightened the import scan (`7650265`).
- `tests/unit/agents/prompt-tool-parity.test.ts`: a worker prompt may only advertise tools the worker
  holds, and may not key a rule on a directive no `src` module emits.

## Why

- Audit §3 (`docs/plans/2026-09-28-perf-ux-rag-audit.md`): the duplicate search happened in prod on
  2026-09-26 although the prompt forbade it; `personal_rag` held 4 rows last written 2026-06-15.
- Commit 5 stopped because `scripts/seed-founder-context.ts` is hand-written June data (v2
  architecture, retired tools, Phase D-Bis focus, personal facts) and `deploy/deploy.sh` re-runs it on
  every deploy. `upsertFounderContext` merges the seed over what is stored, which resets the founder's
  own `current_priorities` and `next_actions` each time `main` deploys. A card built on that would put
  June priorities into every worker as "FOUNDER FACTS".

## Metrics

- `pnpm gate` on `7650265`: exit 0. `verify:branch` OK, lint, build, runtime assets, wiring
  (17 warnings, all pre-existing prompt-mention gaps), `verify:arch` (every rule = baseline,
  loc-budget 6), doc-claims (6 claims agree), **tests 4,910 passed / 429 files, 0 skipped**.
- Baseline on the merged branch before any change: 4,875 / 4,876 across 426 files. The one failure,
  `claude-code-git-guard.test.ts`, comes from `GIT_CONFIG_*` variables this sandbox injects; it
  passes with them unset, and the final runs were made with them unset.
- RED before each fix: duplicate-table check (`research: search_knowledge + search_turicks_brain both
  read brain_memories`), `top_k` ignored (expected 8, got 5), MCP limit (expected [8], got [5]),
  personal still holding `search_personal_rag`, two orphaned directives in the research prompt,
  `turicks_brain` accepted by the allowlist.
- Mutation probes, each red then restored: checker comparison removed; `search_turicks_brain`
  re-bound to research; a new RAG-reading tool bound without a map entry (via `../db/rag-query.js`
  and via a sibling `./rag.js`); a map entry naming the wrong table; the research prompt advertising
  an unheld tool.

## Outstanding

- **NOT VERIFIED — `pnpm eval:retrieval`** against the 83.8% recall@5 baseline (2026-08-25). Needs
  the local dev corpus. `search_knowledge` still calls the same engine and table, and its default
  count is unchanged.
- **NOT VERIFIED — live Telegram.** "What are my skills?" should be planned to jobhunt and answered
  through `read_cv`; a research question should make one brain call. Check that turn's
  `trace tool.call` lines after deploy. The planner may also send the skills question to admin
  (`read_context`), which this branch does not change.
- **NOT VERIFIED — prod `founder_context` contents and brain rows.** No VPS or brain MCP from this
  session.
- **Unblock the founder card:** make the deploy seed insert-only for founder-authored keys (or stop
  seeding on deploy), retire its stale architecture keys, then build the card from the
  `context-guard.ts` allowlist. Needs a founder decision — it changes what prod stores.
- **Found, not fixed:** MCP `read_context` returns `ctx.context_data`, which does not exist, so it
  returns no context; `read_context` renders the `budget_alerts_sent` bookkeeping key as
  `[object Object]`; `scripts/sql/prod-metrics.sql` still counts `brain.turicks_brain`.
- Brain sync after merge (this adds `docs/`).
