# 2026-09-28 — founder_context: deploy seed overwrote the founder, MCP read_context returned nothing

## What we did

Fixed three bugs in how `agents.founder_context` is read and written, found while executing
`docs/plans/2026-09-28-rag-retrieval-cleanup.md` (PR #756, whose commit 5, the per-worker "founder
card", was held back because of bug 1).

- **Deploy seed is fill-only.** `scripts/seed-founder-context.ts` (run by `deploy/deploy.sh` and
  `scripts/vps-prod-stabilize.sh` on every deploy) now calls `seedFounderContextDefaults`, which
  writes a seed key only when the stored row lacks it, never touches `last_updated`, and writes
  nothing when every key is present. The seed CONTENT was not changed: refreshing it is the
  founder's decision (see Outstanding).
- **MCP `read_context` returns the context.** It serialised `ctx.context_data`, a key that does not
  exist (`getFounderContext` returns the stored object itself), so every call answered `undefined`.
  Its `if (!ctx)` empty check could never fire because `{}` is truthy.
- **Internal keys never reach the founder.** `src/db/founder-context.ts` holds the one list
  (`INTERNAL_CONTEXT_KEYS`, currently `budget_alerts_sent`) and `founderFacingContext()`. The
  `read_context` tool, `search_memory`'s context section and MCP `read_context` all filter through
  it. `BUDGET_ALERTS_KEY` moved there (re-exported from `src/infra/daily-budget.ts`).
- `upsertFounderContext` no longer bumps `last_updated` for a bookkeeping-only write, so a budget
  alert no longer shows up as "Last updated" on the founder's context.
- `scripts/sql/prod-metrics.sql` counts `brain.brain_memories` instead of the frozen
  `brain.turicks_brain` (ADR-038).

## What we fixed

| Defect | Found by | Fix |
|---|---|---|
| Every deploy replaced the founder's `current_priorities` / `next_actions` with June seed values and set `last_updated` to deploy time, so June data also looked fresh | reading `upsertFounderContext` (`{ ...current, ...updates }`) against `deploy.sh:196` | fill-only `seedFounderContextDefaults` |
| MCP `read_context` always returned `undefined` | reading `src/mcp/server.ts` against `getFounderContext`'s return type | return the filtered object; empty = no founder-facing key |
| `read_context` printed `budget alerts sent: [object Object]` | the alert sweep stores its dedupe state in the same JSONB row | one `INTERNAL_CONTEXT_KEYS` list, filtered in every render |
| A budget alert moved the founder's "Last updated" | same row, same writer | `last_updated` only moves on a founder-facing key |

## Why

The seed was written as a one-shot bootstrap ("run once") and later wired into every deploy without
changing its merge direction. A script that runs unattended on every deploy must never win against
data a person entered. The MCP bug survived because its only test asserted "some text content came
back", which `undefined` satisfied. The new tests assert the actual payload.

## Metrics

- RED before the fix: 10 failing tests across the 5 test files (seed run: stored priorities replaced
  by the 5 June items; MCP: `expected undefined to be type of 'string'`; renders contained
  `budget alerts sent`).
- GREEN after: `pnpm gate` exit 0, 429 test files / 4,897 tests. Run with the cloud container's
  `GIT_CONFIG_*` variables unset: with them set, `claude-code-git-guard.test.ts` fails identically on
  `beta` (the test hardcodes `GIT_CONFIG_KEY_0`; the container pre-sets `GIT_CONFIG_COUNT=3`).

## Outstanding

1. **Founder decision, seed content:** the prod row still holds the June values the old seed kept
   rewriting (`current_priorities`, `next_actions`, `open_decisions`, v2 `tech_stack`,
   `founderos_departments` naming retired tools). Fill-only does not remove them. Until the founder
   saves new priorities through the bot once, "What's my focus?" still answers from June.
2. After merge + deploy: ask "What's my focus?" in Telegram, save new priorities, deploy again, and
   confirm the prod row keeps them.
3. Brain sync after merge (`gh workflow run brain-sync.yml`), since this adds a doc under `docs/`.
