# AG-054 — One agent loop beside the kernel, then A/B and switch

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-054.
Supersedes AG-038, AG-032 and AG-033.
**Depends on:** AG-053 (one registry) and AG-055 (in-flight block). It can start on the registry branch.
**Branch:** `task/issue-<N>-one-agent-loop`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: the turn path, approvals, cost.
**Moves:** A.

Read [STANDARDS.md](STANDARDS.md), `docs/rules/CLAUDE-RULES-RATIONALE.md` (the HITL entries) and
`~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

One model sees the conversation, every tool and every result, and answers, the way Claude Code does on the laptop. It
runs beside the current kernel behind a flag and takes over only if it wins a measured A/B.

## Problem (measured)

- Three partial brains. The planner (`src/kernel/planner.ts`) reads the chat but has no tools. The worker
  (`src/kernel/worker.ts:4-5`) has tools but "never sees the conversation". The synthesizer sees only validated
  results.
- Planner history keeps 2,000 characters in and 1,500 out per turn (`planner.ts:227-228`), and drops everything after
  6 hours of silence (`state.ts:175`).
- The golden set scores 53% on cheap models and 53% on Sonnet. AG-038's gate was 85%, so its condition is met.
- On 10-08, "On it…" stayed after a Reject, and a `/login` paste waited behind a running turn's chat lock.

## Expected behavior

1. **`src/loop/`** (new): one `createReactAgent`-style loop, or a hand-written one if that is clearer in under 300
   lines.
   - System prompt under 60 lines: who the founder is (from `founder_context`), the date, the accounts list from
     `src/core/accounts.ts`, and the rules for replies.
   - Context: the last 20 turns in full, then AG-055's in-flight block, then the message.
   - Tools: AG-053's `ALL_TOOLS`.
   - Tool results are capped per call. Reuse each tool's existing caps, such as `github-pr.ts` `MAX_PATCH_TOTAL`.
   - Prompt caching: the system prompt and tool block go first, unchanged between turns.
2. **Guarantees stay.**
   - Write tools still call `hitlGate()` inline, so the approval card, the DB row before `interrupt()` and the
     idempotency key are unchanged.
   - Receipts are recorded by code from tool calls, as `worker.ts` does today.
   - `src/kernel/claim-check.ts` runs on the final reply against those receipts.
   - Budget caps (`RUN_BUDGET_USD`, `RUN_BUDGET_TOKENS`, tool-call limits from #1013) apply per run.
3. **Gateway.**
   - `LOOP_MODE=off|shadow|on` in `src/gateway/kernel-run.ts`. `shadow` runs the loop on a copy of the turn, sends
     nothing, and logs its reply next to the kernel's for comparison.
   - Commands, login pastes and approval taps never wait behind a running turn's lock.
   - One progress message per turn, edited to its final state on every outcome: reply, reject, error, timeout.
4. **A/B.**
   - Run `pnpm eval` with the loop against the kernel on the same 15 cases, each with the cheapest model that passes
     (#991's per-run model override).
   - Then run the 5 journeys from AG-051 under both, and 20 shadow turns from real founder traffic.
   - Table: pass rate, p50 latency, cost per turn.
5. **Switch.** If the loop wins on pass rate and costs no more than 2× the kernel per turn, set `LOOP_MODE=on`. If it
   does not win, stop and write up what lost. The plan's day-5 checkpoint decides.

## Files in scope

`src/loop/` (new), `src/gateway/kernel-run.ts`, `src/gateway/kernel-boot.ts` (composition root), `src/eval/`,
`scripts/verify-architecture.ts` (allow `src/loop` in the import rules), tests in `tests/unit/loop/`.

## Constraints

- The kernel is not modified. Both paths must run from the same boot.
- `pnpm test` stays at $0: the loop's offline test uses a scripted model, like `kernel-e2e.test.ts`.
- 400 lines per file. No prompt rule replaces a code guard: routing and parsing stay in pure functions.
- Temperature 0.

## Explicitly forbidden

- Deleting any kernel module. That is AG-057, after 2 days on `on`.
- A router or planner stage in front of the loop.
- Adding a guard module. If the loop needs one, the A/B table says why.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/loop tests/unit/gateway tests/unit/kernel
pnpm eval   # paid, once per variant
```

## Acceptance criteria

- Offline e2e: a scripted loop turn reads a tool, asks for approval on a write, resumes after the tap, and records
  receipts. Claim-check rejects a reply that claims an unreceipted action.
- The A/B table in the PR body, from real runs.
- After `LOOP_MODE=on` on prod: J1 to J5 pass in one morning run, and a follow-up ("and the oldest one?") resolves
  without the founder repeating the PR number. Paste both.
