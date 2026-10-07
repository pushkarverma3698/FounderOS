# AG-031 — Know which model answered, then A/B a stronger model on the understanding set

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 2.
**Depends on:** part 1 none; part 2 needs AG-030 merged.
**Branch:** `task/issue-<N>-model-truth-ab`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: model selection and prod env, third-party APIs, money.
**Moves:** A. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

1. Cost rows record the model that actually answered each stage. Today they cannot be trusted.
2. One table tells the founder which model makes FounderOS understand him, at what cost per turn and what latency.

## Problem / observed behavior

- Prod `.env` (read 2026-10-07): `AGENT_MODEL=google-genai:gemini-3.6-flash`,
  `WORKER_AGENT_MODEL=openrouter:inclusionai/ling-3.0-flash`, `OPENROUTER_API_KEY` set.
- `kernel-boot.ts` wires `getWorkerModel()` into the worker and synthesizer stages.
- Yet all 311 `agents.ai_call_costs` rows of 10-01 → 10-07 say `google-genai:gemini-3.6-flash`: 99 engineering,
  73 planner, 46 kernel, 46 synthesizer, 22 worker, 15 admin, 9 other.
- Hypotheses, none verified:
  - (a) `buildModel(..., { optional: true })` returns null for this id, and `getWorkerModel()` silently falls back to the
    primary (`model.ts:272-279`);
  - (b) the cost callback records a constructor id, not the responding model;
  - (c) a ling failure falls through a chain that ends at Gemini.
- The planner runs on Flash and fails the cases a stronger model is expected to pass: invented filler
  ("actively executing", "95% of candidates") and misread follow-ups.

## Expected behavior

**Part 1: model truth (no golden set needed).**
1. A failing unit test reproduces the mismatch: with `WORKER_AGENT_MODEL` set to a valid OpenRouter id, a worker-stage call
   records that id in the cost row. Fix the root cause the test exposes.
2. When `getWorkerModel()` falls back to the primary, it logs once at boot with the reason
   (`worker model <id> unavailable: <why>; using <primary>`). `/where` or the boot report shows the effective model per
   stage.
3. One prod check after deploy: `select model, agent, count(*) from agents.ai_call_costs where created_at > <deploy>`
   shows the effective worker model.

**Part 2: A/B (after AG-030).**
4. `scripts/run-eval.ts` accepts `--planner-model <id>` and `--worker-model <id>` overrides for one run, through the same
   `parseModelId`/`buildModel` path as prod.
5. Run `pnpm eval --suite understanding` once per configuration and report in the PR body:

   | Config | Planner | Worker + synth | Pass % | p50 / p90 latency | $ per turn |
   |---|---|---|---|---|---|
   | baseline | gemini-3.6-flash | effective today | | | |
   | B | claude-sonnet-5-5 | gemini-3.6-flash | | | |
   | C | claude-sonnet-5-5 | claude-sonnet-5-5 | | | |
   | D | gemini Pro (current id) | gemini Pro | | | |

   Use the provider prefixes `parseModelId` already supports (grep before adding one). If the Anthropic provider is not
   wired, wire it in this PR with a failing test first.
6. Recommend one config in the PR body. **The PR does not change prod `.env`.** The switch is a founder decision, applied
   through `apply-prod-env-overrides.sh` after merge.

## Files or subsystem in scope

`src/agents/model.ts`, `src/agents/worker-invoke.ts`, `src/infra/budget.ts` (cost callback), `src/infra/boot-report.ts`,
`scripts/run-eval.ts`, tests.

## Constraints

- `src/agents/model.ts` is 391 lines (cap 400). Put new code in a new module.
- Temperature stays 0 (`resolveTemperature()`).
- Paid calls: exactly one live eval run per row of the table.

## Explicitly forbidden

- Editing `/opt/founderos/.env` or any prod file.
- Picking the winner by pass rate alone: report latency and cost in the same table.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/agents tests/unit/infra
pnpm eval --suite understanding --planner-model <id> --worker-model <id>   # once per row
```

## Acceptance criteria

- The failing test is red on `origin/beta` and green on the head (paste both runs).
- The table is filled from real runs.
- Prod check (part 1) run once after deploy, output in the PR thread.
- NOT VERIFIED lists any hypothesis left unconfirmed.
