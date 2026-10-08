# AG-050 — Cheap default models, an explicit output cap, free-only fallback

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-050.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-cheap-models-output-cap`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: money, model routing.
**Moves:** A.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

A normal turn costs cents again, and a credits-low account still answers. Sonnet stays available only as an explicit
choice that AG-054's A/B has to earn.

## Problem (measured 2026-10-08)

- `scripts/apply-prod-env-overrides.sh:155-162` sets `AGENT_MODEL` and `WORKER_AGENT_MODEL` to
  `openrouter:anthropic/claude-sonnet-5.5`. That was a trial (#1015). It moved the 15-case golden set from 53% to 53%
  and cost about $0.33 a turn ($5.77 on 10-08).
- No model constructor in `src/agents/model.ts:318-392` sets an output limit, so OpenRouter reserves the model's full
  output window (65,536 tokens for Sonnet) against the balance. That is why a 402 arrived with credit still on the key.
- `WORKER_FALLBACK_MODELS` (line 159) and `PLANNER_FALLBACK_MODELS` (line 160) list paid models: deepseek-v4-flash,
  deepseek-v4.1-flash, gemini-3.6-flash, mimo-v2.6-flash, jev-router. The founder's rule is a free fallback only.
- The cost ledger undercounts against OpenRouter's own usage number. The cause is unknown.

## Expected behavior

1. **Defaults** in `apply-prod-env-overrides.sh`:
   - `AGENT_MODEL`: gemini-3.6-flash. Use `google-genai:` if the AI Studio key answers a one-token call at build time;
     otherwise use `openrouter:google/gemini-3.6-flash`. Write which one you used, and why, in the PR.
   - `WORKER_AGENT_MODEL`: `openrouter:inclusionai/ling-3.0-flash`.
   - `JUDGE_MODEL`: gemini-3.1-flash-lite, through the same provider choice. The judge stays a different model from the
     drafter (see the comment at line 135).
   - All three fallback lists: `openrouter:nvidia/nemotron-3-super-120b-a12b:free` only.
2. **Output cap.** One `MODEL_MAX_OUTPUT_TOKENS` setting in `src/core/config.ts`, default 4096, read by every
   constructor in `model.ts`, the fallback models and `src/infra/judge-model.ts`. Each provider gets its own field name:
   `maxTokens` for OpenAI/OpenRouter and Anthropic, `maxOutputTokens` for Google.
3. **Ledger.** Compare one day of `action_log`/budget rows with OpenRouter's `/api/v1/activity` (or `/api/v1/credits`
   before and after a probe). Name the gap, for example "cached tokens not priced" or "the fallback model is missing
   from MODEL_COSTS". Fix it if the fix is under 40 lines; otherwise record it in the PR as NOT VERIFIED with the
   measured gap.
4. **Sonnet stays one line away.** `apply-prod-env-overrides.sh` keeps a commented `# SONNET_TRIAL` block, so switching
   back is a single uncomment.

## Files in scope

`scripts/apply-prod-env-overrides.sh`, `src/agents/model.ts`, `src/infra/judge-model.ts`, `src/core/config.ts`,
`src/infra/budget-costs.ts`, `.env.example`, tests under `tests/unit/agents/`.

## Constraints

- No paid model in any fallback list. A unit test reads the override script and fails on any fallback slug without
  `:free`.
- Never print an API key. Credits checks print the balance only.
- `pnpm test` stays at $0.

## Explicitly forbidden

- Changing planner, worker or synthesizer prompts. Model choice and the cap are the only levers here.
- Raising `RUN_BUDGET_USD` or `BUDGET_DAILY_USD`.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/agents
```

## Acceptance criteria

- A failing test first, then green: every model `model.ts` builds carries the output cap, and no fallback slug is paid.
- `pnpm eval` once on the new defaults. Paste the score next to 53%. A drop of more than 7 points blocks the merge.
- After deploy: 3 Telegram probes through `scripts/telegram-probe.ts` (PR list, inbox, a reminder). Paste each reply,
  its latency, and the OpenRouter credit delta for all three.
