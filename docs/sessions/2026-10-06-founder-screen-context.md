# 2026-10-06 — founder screen context (P1 shipped, P2–P5 re-scoped)

Goal (founder, 2026-10-05): FounderOS answers with the context the founder has, instead of assuming.

## Shipped
- #921 (screen log) merged to beta as `b22bc57d`. Plan: `docs/plans/2026-10-06-founder-screen-context.md`.
- #920 promoted the thin-slice work to main (`23508ed3`); the deploy succeeded, prod serves `23508ed3`, kernel booted.
- #924 promotes #921 (tree identical to beta). Deployed only after it merges.

## Findings from the P2/P3 recon
1. **P2 (situation snapshot) is mostly built.** `/where` answers "where are we" with no LLM, and the planner prompt routes that phrasing to it (`src/kernel/planner.ts:104`, `src/gateway/where-command.ts`). Injecting a snapshot into every planner turn would cost thousands of tokens to repeat it. Drop P2 unless a probe shows a question `/where` cannot answer.
2. **P3 (goals from plain words) must not write through a model tool.** `tests/unit/goals/no-llm-goal-tools.test.ts` forbids any model-reachable code from touching goals: guests in the allow-listed group reach the same kernel.
   A safe path exists already: a planned command replays as a synthetic update through the same owner-only middleware (`src/gateway/telegram.ts:144`, `src/gateway/command-dispatch.ts`), and `goal` is not read-only, so it asks for a tap.
   So "my goal this month is X" can reach `/goal add` today. What blocks it is the grammar: `goal add title | metric=key target=n by=date` needs a metric key, and the planner rule "never invent an argument" makes it ask for one. Zero rows in `goals` is therefore a usability gap, not a missing capability.
   Next step (not done): one golden-set row in `src/eval/command-golden.ts` ("my goal this month is 20 applications") and a live run to see what the planner does. That run spends money (rule: one live run after a failing test).
3. **Gmail and Calendar providers are DOWN in prod** (`invalid_grant`, logged at boot 2026-10-05 21:41Z by `provider-probes`). P4 (calendar read) needs a re-auth before it can work at all.

## NOT VERIFIED
- Live screen log path after #924 deploys: alert lands, `scripts/telegram-probe.ts` asks "what repo is the last blocked PR on?", reply names the alert's repo.
- `sudo -n -u founderos ls -l /home/founderos/.claude/screen.jsonl` shows `-rw-------`.
- Planner token cost with the screen block present.
- What the planner does with a plain-words goal (finding 2).
