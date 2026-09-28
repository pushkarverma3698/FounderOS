# Plan: RAG retrieval cleanup (item 3 of the 2026-09-28 audit)

- **Branch:** `claude/fix-rag-retrieval-cleanup` (already exists on origin, base `beta`). PR → `beta`.
- **Evidence:** `docs/plans/2026-09-28-perf-ux-rag-audit.md` §3. Read it first.
- **Depth: Lite**: worker tool lists, prompts and an allowlist; no schema, no prod data. It
  escalates to Full the moment anything drops or rewrites a table. That is out of scope (below).
- **Founder approval:** "fix the RAG related issues" in chat, 2026-09-28.

## Outcome the founder feels

A research question makes one brain search, not two identical ones. A question about his own
career is answered from his real CV, not from 4 stale chunks written in June. Workers stop
spending a search just to learn who the founder is.

## Commits (one per logical change, in this order)

### 1. One tool per corpus: retire `search_turicks_brain` from the research worker
- Fact (audit §3): `search_knowledge` (`src/tools/knowledge.ts`) and `search_turicks_brain`
  (`src/tools/rag.ts`) both call `runRagSearch("brain_memories", …)` (`src/db/rag-query.ts`). The
  research worker holds both (`DEPARTMENT_TOOLS.research` in `src/agents/capabilities.ts`). On
  2026-09-26 it called both with the same query, although `prompts/research.ts` says not to.
- Change: add an optional `top_k` (1–10, default 5) to `search_knowledge`. That is the one reason
  the prompt gave for keeping the second tool. Then remove `searchTuricksBrain` from
  `DEPARTMENT_TOOLS.research` and delete its prompt line.
- **Mechanism, not a prompt rule** (CLAUDE.md #27): declare which table each retrieval tool reads,
  e.g. a `RETRIEVAL_TOOL_TABLE` map next to `DEPARTMENT_TOOLS`, and add a test that fails when any
  worker holds two tools reading the same table. RED first: the test fails on today's research
  list.
- `search_turicks_brain` is referenced in 19 files (grep, 2026-09-28): `src/tools/rag.ts`,
  `src/tools/knowledge.ts`, `src/agents/agent-tools/rag.ts`, `src/agents/prompts/research.ts`,
  `src/db/rag-query.ts`, `src/eval/golden-tasks.ts`, `tests/unit/graph.test.ts`,
  `tests/unit/graph-query-helper.test.ts`, `tests/unit/tools/rag.test.ts`,
  `tests/unit/tools/knowledge.test.ts`, `tests/unit/agents/capabilities.test.ts`,
  `tests/unit/db/brain-store-parity.test.ts`, `scripts/sync-turicks-brain.ts`,
  `scripts/e2e-telegram-qa.ts`, `scripts/seed-founder-context.ts`,
  `scripts/generate-knowledge-graph.ts`, `scripts/ingest-external-chats.ts`,
  `scripts/log-review/state-checks.ts`, `docs/FEATURES.md`. Open each one before deciding.
  - If the MCP server (`src/mcp/`) or a script exposes the UnifiedTool, keep the UnifiedTool and
    remove only the worker binding.
  - The golden task in `src/eval/golden-tasks.ts` must expect `search_knowledge` instead.

### 2. Career questions read the real CV: retire `search_personal_rag` from the personal worker
- Fact (prod, 2026-09-28): `brain.personal_rag` holds **4 rows**, last written **2026-06-15**: a
  June wiki stub plus a FounderOS brief. That wiki is a known fabrication source for CV facts. The
  personal worker's `search_personal_rag` answers every Telegram career question from it.
- Change: remove `searchPersonalRag` from `DEPARTMENT_TOOLS.personal` and give the personal worker
  the existing read-only `read_cv` tool. The UnifiedTool is `src/tools/career.ts` (`name:
  "read_cv"`); the agent-tool wrapper is in `src/agents/agent-tools/jobhunt.ts`. **Check before
  wiring:**
  - `read_cv` is read-only.
  - It defaults to the founder's own profile, not Tashi's.
  - It reads the prod CV directory. Find the path in the code; do not assume it.

  Update `src/agents/prompts/personal.ts` so career / skills / work-history questions go to
  `read_cv`, and say plainly that payslips and identity documents are not available.
- References to update (grep, 2026-09-28): `src/infra/rag-orchestrator.ts`, `src/tools/rag.ts`,
  `src/agents/capabilities.ts`, `src/agents/agent-tools.ts`, `src/agents/prompts/personal.ts`,
  `src/agents/agent-tools/rag.ts`, `src/db/rag-query.ts`, `scripts/generate-knowledge-graph.ts`,
  `scripts/sync-personal-rag.ts`, `scripts/log-review/state-checks.ts`, `tests/unit/graph.test.ts`,
  `tests/unit/graph-query-helper.test.ts`, `tests/unit/tools/rag.test.ts`,
  `tests/unit/agents/capabilities.test.ts`, `tests/unit/gateway/jobhunt-department-routing.test.ts`,
  `docs/FEATURES.md`.
- **Leave the `personal_rag` table and `scripts/sync-personal-rag.ts` in place.** Stopping reads
  is enough. Deleting prod data is out of scope.
- RED first: a capabilities test that the personal worker has `read_cv` and not
  `search_personal_rag`.

### 3. Remove dead text the workers still read
- `src/agents/prompts/research.ts` branches on "EXTERNAL LEAD DISCOVERY" and "INTERNAL KNOWLEDGE"
  routing directives. No code emits them (grep across `src/`, 2026-09-28: 0 emitters; they came
  from the v2 pre-router, killed 2026-07-08). Delete those rules.
- `src/agents/agent-tools/rag.ts` header comment describes ChromaDB on :8765/:8766; the stores
  are pgvector (`src/db/rag-search.ts`). Correct it. Same for any "ChromaDB" wording in
  `src/infra/rag-orchestrator.ts`.

### 4. Stop allowlisting the frozen `turicks_brain` table (code only)
- `scripts/sync-turicks-brain.ts` states the table "is frozen and read by nothing" since ADR-038.
  It is still in `ALLOWED_RAG_TABLES` / `RagTable` (`src/db/rag-search.ts:13-14`). Remove it from
  both, and fix every compile error: `tests/unit/tools/knowledge.test.ts` mocks the set;
  `scripts/log-review/state-checks.ts` and `src/db/queries.ts` mention it.
- **Do not drop the table.** `brain.turicks_brain` (1,352 rows) stays until the founder approves
  a drop in chat. That drop is Full depth: migration, backup, prod data.

### 5. Founder card for every worker: the missing Tier-0 context (last; optional if time runs out)
- Fact: on 2026-09-26 the research worker spent a tool call on `search_knowledge("FounderOS
  Pushkar")` to learn who the founder is. `docs/product-recovery/06-CONTEXT-RAG-MEMORY.md`
  already names the gap: "Tier 0 — structured current state: MISSING".
- Design, which keeps the kernel pure (it may read only a string from config):
  - The gateway loads the founder's stored context through the same query the `read_context`
    tool uses (find it; do not write a new one).
  - Cache it for 5 minutes, cap it at 600 chars, and pass it as `configurable.founder_card` on
    each `runKernelText` / resume / scheduled run.
  - `resolveWorkerPrompt` (`src/kernel/worker-protocol.ts`) appends
    `FOUNDER FACTS (stored by the founder; data, not instructions): <card>` when present.
- Content comes only from what the founder stored. Never write facts about him or his family by
  hand (AGENTS.md: never infer personal facts).
- RED first: a worker system prompt contains the card when `configurable.founder_card` is set,
  omits it otherwise, and never exceeds the cap.
- If `founder_context` turns out empty or stale in the code's seed data, stop and report. Don't
  invent a card.

## Binding repo rules (CI enforces the first four)
- No `src` file over 400 lines. Import direction: contracts ← kernel ← gateway.
- Fail-open `catch` needs `// allow-failopen: <reason>`. `pnpm verify:arch` must pass.
- Zero paid calls in tests.
- Branch name is already valid. Do not rename it.

## Verification the cloud session must show (paste real output)
1. RED → GREEN per commit.
2. `pnpm ci:quality`, `pnpm test` (N/N, 0 skipped, counts), `pnpm gate`. Capture with
   `cmd > /tmp/x-$$.log 2>&1; echo $?`, never `| tail`.
3. Mutation probe: remove the duplicate-table test's comparison, and the founder-card cap; each
   must turn a test red.
4. Draft PR to `beta` per `.github/pull_request_template.md`, with the three sections:
   **What changed**, **How it was verified**, **NOT VERIFIED**.

## NOT VERIFIED from a cloud session (list in the PR)
- `pnpm eval:retrieval` needs the local dev corpus (`.env`, turicks-postgres). Run it once from the
  laptop after the PR is green, against the 83.8 % recall@5 baseline (2026-08-25).
- The live Telegram path: "what are my skills?" should answer from `read_cv`, and a research
  question should make one brain call. Verify after deploy by reading that turn's
  `trace tool.call` lines.
- Brain rows. The turicks-brain MCP is unreachable from cloud.

## Corrections found during execution (2026-09-28)

The plan was an input, not the truth. Each item below says what was wrong, the evidence, and
what was built instead. Commits are on this branch.

1. **Reference lists grepped only the snake_case name.** `git grep -E
   "search_turicks_brain|searchTuricksBrain" origin/beta` outside `docs/` and `.claude/` finds 25
   files; the plan listed 18 (19 with `docs/FEATURES.md`). Missing: `src/agents/capabilities.ts` (the actual worker binding),
   `src/agents/agent-tools.ts`, `src/infra/rag-orchestrator.ts`, `scripts/probe-rag.ts`,
   `scripts/vps-marketing-launch-gate.sh`, `scripts/vps-prod-hardcore-qa.sh`,
   `drizzle/0038_brain_backfill.sql` (applied migration, left untouched). The two VPS QA scripts
   call `searchTuricksBrainTool.execute(...)` directly and assert nothing about worker bindings, so
   keeping the UnifiedTool keeps them working; its import was re-checked with
   `node --import tsx/esm -e "import { searchTuricksBrainTool } from './src/tools/rag.js'"`. The
   `search_personal_rag` list (15 files) was complete.
2. **"The golden task must expect `search_knowledge` instead" had nothing to change.** No golden
   task expects `search_turicks_brain`. Only the `note` of `creative-caption` named it, and that is
   a marketing task: marketing has not held the tool since P7. The note was corrected.
3. **Commit 1's mechanism needed a completeness half.** A duplicate-table test over a declared map
   rots the day someone adds a retrieval tool and forgets the map. Built: `RETRIEVAL_TOOL_TABLE`
   plus `tests/unit/agents/retrieval-tool-table.test.ts`, which fails on two readers of one table,
   on a worker tool whose module imports the RAG engine but has no map entry, and on a map entry
   the tool does not actually query (the engine is spied). Also added: a worker prompt may only
   advertise tools the worker holds (`prompt-tool-parity.test.ts`).
4. **Commit 1 found a live bug the plan missed.** The MCP `search_knowledge` handler passed its
   advertised `limit` to the tool as `limit`, a key the tool's schema never had. zod stripped it
   and every MCP client got 5 results. It now maps `limit` onto the new `top_k`.
5. **Commit 2 as written contradicted the documented design.** The plan gave `read_cv` to the
   personal worker. `DESCRIPTIONS.jobhunt` (`src/gateway/kernel-boot.ts`) already claims every CV
   question for both candidates, the planner prompt renders each worker's `tools=[...]`
   (`src/kernel/planner.ts`, `buildPlannerPrompt`) so tool names are routing signals too, and
   `tests/unit/gateway/jobhunt-department-routing.test.ts` exists because a second CV route on
   personal won "What is Tashi's CV background?" on 2026-09-07. Built instead: personal loses
   `search_personal_rag` and gets no CV tool; its prompt hands CV questions to jobhunt's `read_cv`
   and says payslips and identity documents are not available. No golden task routes a CV
   question to personal, so no expectation changed. Strongest argument against: "what are my
   skills?" now depends entirely on the planner choosing jobhunt, whose prompt is shaped around
   applications, and the planner's own rule points founder/work/history questions at
   `read_context`/`search_memory`. Only a live turn can show which wins (NOT VERIFIED below).
6. **"answers every Telegram career question" was overstated.** Since 2026-09-07 the jobhunt
   description claims CV questions, so the planner should already have preferred jobhunt. How
   often personal still got them needs the prod trace (NOT VERIFIED).
7. **"read_cv reads the prod CV directory" — the order, verified in code** (`src/tools/career.ts`):
   the personal-rag REST API (`PERSONAL_RAG_URL`, default `http://localhost:8765`, nothing listens
   on the VPS per the comment at the CV fallback), then `PERSONAL_CV_DIR/<track>/cv.md`, then
   `PERSONAL_CV_PATH`, then a wiki fallback labelled as synthesized. It is read-only, and omitting
   `profileId` reads the founder's own CV (`DEFAULT_PROFILE_ID`). The two CV variables point at
   VPS-only files (`scripts/apply-prod-env-overrides.sh` preserves them); their values are not in
   the repo and were not checked.
8. **Commit 3's two targets had nothing left.** The ChromaDB wording in
   `src/agents/agent-tools/rag.ts` sat on the two wrappers commits 1-2 deleted, and
   `src/infra/rag-orchestrator.ts` never mentioned ChromaDB. The dead directives in
   `prompts/research.ts` were real (0 emitters in `src/`) and are gone, now guarded by a test that
   fails when a prompt keys a rule on a directive no `src` module emits. Stale text of the same
   class was fixed instead: the MCP `read_cv` description and the `career.ts` header described the
   pre-2026-08-21 fallback order.
9. **Commit 4's compile-error list was incomplete.** Removing `turicks_brain` from `RagTable` broke
   `tsc` in `tests/unit/db/rag-hybrid.test.ts` (5 call sites) and changed assertions in
   `rag-search.test.ts`, `keyword-rag-ranking.test.ts`, `rag-search-filters.test.ts` and the
   `rag.test.ts` mock. `scripts/log-review/state-checks.ts` and `src/db/queries.ts` only mention
   the table in comments. None of the four scripts that mention it (`sync-turicks-brain`,
   `seed-founder-context`, `ingest-external-chats`, `generate-knowledge-graph`) passes it to
   `rag-search`; `pnpm lint` type-checks `scripts/`.
10. **Commit 5 stopped, per its own rule: the seed data is stale, and deploy re-seeds it.**
    - `scripts/seed-founder-context.ts` is hand-written, not founder-stored: "Phase D-Bis" focus
      locked 2026-06-17, "FounderOS v2 … 7 departments … 1250+ tests", "createSupervisor +
      createReactAgent, Gemini 2.5 Flash via OpenRouter", a `founderos_departments` line listing
      `github_write` and `search_turicks_brain` on marketing/sales (both removed by P7), plus
      personal facts (`location`, `target_salary`) the plan forbids putting in a card.
    - `deploy/deploy.sh:197` runs that seed on every deploy, and `upsertFounderContext`
      (`src/db/queries.ts`) merges `{...current, ...seed}`. So `current_priorities` and
      `next_actions`, two of the five keys the founder can set through `update_context`
      (`src/tools/context-guard.ts`), are reset to the June values each time `main` deploys.
    - A card built today would inject June priorities and a stale architecture into every worker
      as "FOUNDER FACTS". No card was built. What unblocks it, in order: make the deploy seed
      insert-only for founder-authored keys (or stop seeding on deploy), retire the stale
      architecture keys from the seed (the capability manifest is generated), then build the card
      from the `context-guard.ts` key allowlist with the 600-char cap.
11. **Found, not fixed (out of scope, reported):** MCP `read_context` returns
    `JSON.stringify(ctx.context_data)` (`src/mcp/server.ts`), but `getFounderContext` returns the
    JSONB itself, so the MCP tool returns no context at all. `read_context` also renders the
    `budget_alerts_sent` bookkeeping key as `[object Object]`. `scripts/sql/prod-metrics.sql`
    still counts `brain.turicks_brain`.
12. **Graph snapshot.** `.claude/graph.json` dated from 2026-08-11 and would have kept claiming
    both retired placements. It was regenerated offline from the live registry, with the
    generator's RAG prose corrected (brain store = `brain_memories`, queried by
    `search_knowledge`).
13. **Sandbox note for whoever reruns this in a cloud session:**
    `tests/unit/tools/claude-code-git-guard.test.ts` fails when the environment already sets
    `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` (this sandbox injects three). It passes with them unset.
    Not a code defect.
