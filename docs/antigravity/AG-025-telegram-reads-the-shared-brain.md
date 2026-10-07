# AG-025 — Telegram reads the shared brain, and every brain answer shows date, origin and "no strong match"

**Source:** [docs/plans/2026-10-06-one-brain-context-audit.md](../plans/2026-10-06-one-brain-context-audit.md), H2, H3 (read side), H7.
**Branch:** `task/issue-<N>-telegram-reads-shared-brain`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full. It changes worker tool sets, the planner prompt and what every retrieval answer looks like.
**Moves:** B. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

A decision Mac Claude or Antigravity saved with `save_decision` is findable from Telegram's admin and engineering
workers. Every brain hit shows when it was written and by whom. When nothing really matches, the answer says so.

## Problem / observed behavior

- `src/tools/memory.ts:65-97`: admin's `search_memory` reads `episodic_memory`, legacy `knowledge_entries`
  (keyword ILIKE, `src/db/queries.ts:972`), `conversation_turns` and `founder_context`. It never reads `brain.brain_memories`.
- `src/agents/capabilities.ts:124-136`: only research, marketing and sales hold `search_knowledge`, the one reader of
  `brain_memories`. Engineering, which answers "what work happened", has no memory tool.
- Prod: 166 rows with `source = 'ide_mcp'` (agent decisions and bugs, 09-07 → 10-06) are unreachable from admin answers.
- `src/mcp/brain-tools.ts:116-120` (hub) prints `Score`, `Type`, `Project`, `Source: <metadata.source_path>`. Agent rows have no
  `source_path`, so every one says `Source: unknown`, with no date.
- No threshold anywhere in `src/db` or `src/mcp`. Hub `search_memory` "PR 79 verdict" (10-06) returned an unrelated Oplify
  QA decision at 0.857 and a junk "test decision" row.

## Expected behavior

1. `search_knowledge` is bound to admin and engineering as well. Update the RAG placement comment and
   `RETRIEVAL_TOOL_TABLE` pins in `tests/unit/agents/capabilities.test.ts`. The one-tool-per-table rule still holds.
2. `search_memory` drops its `knowledge_entries` section. It keeps episodic, turns and founder_context.
   Its description tells the model to use `search_knowledge` for decisions, bugs and past agent work.
3. The brain_memories query also selects `source` and `created_at`. Both renderers (`renderRagSuccess` in
   `src/db/retrieval-result.ts` and the hub in `src/mcp/brain-tools.ts`) print one header line per hit:
   `<YYYY-MM-DD> · <origin> · <project or "no project"> · <type>`. Origin is `metadata.origin` when present
   (AG-026 adds it). Otherwise `docs` for `source_path` rows, `agent` for `ide_mcp`, and the `source` value for anything else.
4. Abstain: when the best hit's **cosine similarity** is below `BRAIN_ABSTAIN_SIMILARITY`, the answer starts with
   `No strong match for "<query>". Closest: <header line>` and lists at most 2 hits. First confirm whether hybrid
   hits carry cosine or the fused RRF score (`src/db/rag-search.ts:25`, `src/db/rag-hybrid.ts`). Abstain on cosine only.
   RRF is rank-relative and is always high for rank 1.
5. Calibrate the constant with `pnpm eval:retrieval`. Add 5 golden questions with **no** answer in the brain. Pick the
   highest value that keeps every existing golden hit above it. Write both numbers in the PR body.
6. Planner prompt (`src/kernel/planner.ts`, the "questions about himself" rule near line 134): questions about past
   decisions, bugs, or what Claude or Antigravity did plan a `search_knowledge` step.

## Evidence

Read 2026-10-06 on `origin/main` at `f74e3262`. Prod counts from `brain.brain_memories` the same day.

## Files or subsystem in scope

`src/agents/capabilities.ts`, `src/tools/memory.ts`, `src/tools/knowledge.ts`, `src/db/rag-search.ts`,
`src/db/retrieval-result.ts`, `src/mcp/brain-tools.ts`, `src/kernel/planner.ts` (prompt line only),
`src/eval/retrieval-golden.ts`, tests.

## Constraints

- The golden set runs twice in CI. A shifted golden answer is a finding to report, not a test to delete.
- `src/mcp/brain-tools.ts` and `src/kernel/planner.ts` stay under 400 lines.
- `knowledge_entries` keeps being written by `brain:sync`. Stopping that is a later PR.

## Explicitly forbidden

- A new retrieval tool, or a second tool reading `brain_memories`.
- Hiding hits below the threshold entirely. The founder sees the closest one, labelled.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/agents tests/unit/tools tests/unit/db tests/unit/mcp
pnpm eval:retrieval   # on the VPS checkout used for review, $0
```

## Acceptance criteria

- Unit test: an `ide_mcp` decision row renders `2026-10-06 · agent · founderos · decision`, not `Source: unknown`.
- Unit test: top cosine below the constant → output starts `No strong match`.
- `pnpm eval:retrieval` output in the PR body, with the chosen constant and the no-answer cases.
- Live path (one probe, paid): "what did we decide about the screen log?" in Telegram cites a dated `agent` decision.
  If not run: NOT VERIFIED with the reason.
