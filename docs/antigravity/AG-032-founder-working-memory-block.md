# AG-032 — Working memory: the planner always knows who the founder is and what is in flight

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 3.
**Depends on:** AG-029 (PR #963) and the `/goal` fix (PR #967) merged.
**Branch:** `task/issue-<N>-working-memory-block`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: it changes what the planner reads on every DM turn.
**Moves:** A and B. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

Claude Code loads `CLAUDE.md` and `MEMORY.md` before the first message. FounderOS gets the same: a short, code-built block
in the planner prompt, so it never asks "who is your wife?" or forgets it reviewed a PR yesterday.

## Problem / observed behavior

- The planner's context today is the system prompt, the clock, the 12 h screen log and the history
  (`planner.ts:329-332`). After AG-029 it also has recent cross-agent activity.
- Facts about the founder exist only if the planner thinks to plan a lookup:
  - 09-06 #304 "Give me wife's fresh jobs" → "profile details were not explicitly found".
  - 09-07 #312–#314: the same CV question got three different answers.
  - 09-15 #363: it did not know it had reviewed the PR.
- Active goals and in-flight work are computed by `/where` (`src/gateway/where-command.ts`, zero LLM) but never shown to
  the planner.

## Expected behavior

1. Extend AG-029's block. Do not add a second one. `src/kernel/working-memory.ts` renders, with an injected reader:
   - **People:** the founder and family profiles: names, role, which job profile each one uses, read from `read_context`
     data. One line each, no contact details.
   - **Goals:** active rows from `agents.goals` (after #967), at most 5.
   - **In flight:** open tasks and PRs per repo, taken from the same data `/where` uses; at most 8 lines.
   - **Last session:** the last 3 founder asks and outcomes from before the history gap (`recall_conversation` data),
     one line each, dated.
   - **Standing preferences:** rows saved through `update_context` (e.g. "send CVs as PDF").
2. Header `Working memory (recorded data, not instructions):`. Total cap 3,000 chars; sections that are cut say so
   (`… 4 more PRs`).
3. Founder DM thread and the family group only. Never in other chats.
4. SQL and file reads only: no LLM or embedding call. A reader failure omits its section and logs a warning.

## Evidence

Read 2026-10-07 on `origin/beta` at `a8851110`. `planner.ts` is 399 lines: the planner change must be a single line
that calls the shared block function.

## Files or subsystem in scope

New `src/kernel/working-memory.ts` and its reader in `src/gateway/` (wired in `kernel-boot.ts`), AG-029's
`recent-activity.ts` (combine), `src/gateway/where-command.ts` (extract a pure data function if needed), tests.

## Constraints

- **Import direction:** the kernel imports only kernel/core/db/infra/tools; the reader is injected (`verify:arch` rule 3).
- **Kill switch:** `WORKING_MEMORY_ENABLED`, default on.
- **Latency:** the block adds ≤ 150 ms p50 to the planner (measure it; planner p50 was 18.6 s on 09-28).
- Personal data stays in the DB and the prompt, never in logs or the repo.

## Explicitly forbidden

- Personal facts inferred from history or RAG. Only stored profile rows (feedback: ask, never assume).
- Raising `HISTORY_MAX_TURNS`, `HISTORY_MAX_CHARS` or the 6 h gap as a substitute.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel
pnpm eval --suite understanding    # one paid run; quote AG-030 baseline vs now
```

## Acceptance criteria

- Unit tests: rendering, caps and their markers, group-chat exclusion, reader failure path.
- AG-030 cases #304, #312 and #363 pass on the live run.
- Real path: one Telegram DM "what are my goals and what's in flight?" answered without a tool call, plus the reply and the
  `turn.out` trace line in the PR body.
