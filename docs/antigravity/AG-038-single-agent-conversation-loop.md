# AG-038 — Single-agent conversation loop for read/think turns (build only if the gate says so)

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 9; audit §4
"Why Claude Code feels smarter".
**Depends on:** AG-030 to AG-033 merged and on prod, then one live `pnpm eval --suite understanding` run.
**Gate:** build only if that run is **below 85%** and the founder approves. At ≥ 85% this brief is closed unbuilt.
**Branch:** `task/issue-<N>-conversation-loop`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: kernel architecture.
**Moves:** A. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

Questions and investigations ("why…", "what did we…", "is PR N ready", "where are we on…") run the way Claude Code runs:
one strong model holds the whole conversation, the working memory and every tool result in one context. It keeps calling
read tools until it can answer. Actions that change something still go through today's plan → dispatch → worker path.

## Why this might be needed

Today a turn passes through three LLM calls (planner → worker → synthesizer). Only the planner sees the chat, and the
worker sees only the envelope. AG-032/033 narrow that gap by copying context forward. If the golden set still fails after
them, the loss is in the hand-offs themselves, and copying more context will not close it.

## Expected behavior

1. **Routing (pure code).** `src/kernel/turn-kind.ts` classifies a turn as `read` or `act`:
   - `act` when the planner's typed Plan contains any step whose worker binds a side-effecting tool, or the message starts
     with a command;
   - otherwise `read`.
   The planner's existing JSON decides the kind. No second LLM call.
2. **Read loop.** `read` turns go to a new graph node `converse`, which binds:
   - the full history window plus working memory (AG-032) and referents (AG-033);
   - every read-only tool (the AG-035 classification), with no side-effecting tool bound;
   - a cap of 25 tool calls and 120 s;
   - the strongest model from AG-031's table.
   It answers directly; there is no synthesizer hop.
3. **Safety unchanged:**
   - No side-effecting tool is bound in `converse`, so HITL cannot be skipped. A unit test asserts the bound tool set
     contains no `hitlGate()` caller.
   - Receipts are recorded by code as today. The final reply passes `stripFalsePromises`, the progress guard and the number
     check (AG-034).
   - If the model concludes an action is needed, it ends with a suggested action. The founder's "yes" starts a normal
     `act` turn.
4. **Offline e2e.** `tests/unit/kernel/kernel-e2e.test.ts` gains a scripted `read` turn and stays $0.

## Strongest argument against

The CI invariants and the $0 e2e are built around plan → dispatch → worker. A free loop is harder to keep deterministic and
costs more per turn. Mitigation: determinism stays where it protects the founder (gates, receipts, guards, the act path).
`converse` is read-only by construction. AG-031's cost column decides the model.

## Files or subsystem in scope

New `src/kernel/turn-kind.ts`, `src/kernel/converse.ts`; `src/kernel/graph.ts` (one edge), `kernel-boot.ts` (wiring),
`scripts/verify-architecture.ts` only if a new import direction is needed (justify it), tests.

## Explicitly forbidden

- Binding any tool that writes, sends or spends inside `converse`.
- Removing the plan → dispatch → worker path.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel
pnpm eval --suite understanding    # before vs after, same model
```

## Acceptance criteria

- Gate result quoted at the top of the PR body (the run that triggered the build).
- Golden set ≥ 85% on the live run; follow-up cases no worse than standalone.
- p50 latency of `read` turns reported vs today's 15 s.
- Real path: three Telegram follow-up chains from AG-030 (#361, #525, #561) run live, with replies and traces in the PR body.
