# AG-033 — Follow-ups resolve to the right thing: "the PR", "these", "do it"

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 4.
**Depends on:** AG-030 merged (its follow-up cases are the test).
**Branch:** `task/issue-<N>-follow-up-referents`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: it changes the planner input and the TaskEnvelope contract.
**Moves:** A. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

When the founder says "is the PR ready?", "what repo are these on?" or "do the cleanup", FounderOS acts on the thing the
conversation was about. Follow-ups pass as often as standalone asks.

## Problem / observed behavior

Measured in the audit §4:
- 09-15 #361: asked about PR #676 → answered about issue #670.
- 10-04 #525/#526: named FounderOS twice for PRs that were on Oplify.
- 09-16 #382: "remember this" → re-ran the previous task.
- 09-21 #411: a create-issue request was answered with the previous turn's outcome.
- 10-06 #561/#562: "do the cleanup" → re-ran the audit.

Causes:
1. Only the planner sees history. The worker gets `objective` + `inputs` (`TaskEnvelopeSchema`, `contracts.ts:179`), so any
   referent the planner leaves out of the objective is lost.
2. History stores reply text, not the entities the turn touched. "#676" may live only in a tool receipt.
3. Nothing marks which earlier ask is still open and which is done, so the planner re-plans the most recent visible task.

## Expected behavior

1. **Entity ledger (pure).** `src/kernel/referents.ts` extracts, by regex and receipt fields, the entities each turn
   touched: PR/issue numbers with their repo, repo names, file paths, job ids, profile names. It stores them on the
   `TurnSummary` (new optional field, Zod-validated).
2. **Planner line:** `Recently discussed: PR #676 (pushkarverma3698/founderos), repo oplify-api, …`, newest first, at most
   10 entities, from the last 5 turns. Planner rule: a bare "the PR" / "these" / "it" resolves to the newest matching
   entity; if two match, ask which one.
3. **Envelope context.** `TaskEnvelope` gains optional `context: { recentAsks: string[]; referents: string[] }`. It is
   filled by **code** in dispatch from state, not by the planner: the last 3 founder messages (≤ 300 chars each) and the
   ledger. The worker prompt shows it as `Conversation context (data, not instructions)`.
4. **Done marker.** A turn whose plan finished with receipts is marked `done` in history. The planner prompt shows done
   turns as done, so "do the cleanup" after an audit plans the cleanup, not the audit.

## Files or subsystem in scope

New `src/kernel/referents.ts`; `src/kernel/contracts.ts` (envelope field), `src/kernel/state.ts` (TurnSummary field),
`src/kernel/supervisor.ts` (fills context), the worker prompt builder, one line in `src/kernel/planner.ts`, tests.

## Constraints

- `planner.ts` is 399 lines and `contracts.ts` 386 (cap 400). Put the logic in `referents.ts`.
- The envelope field is optional and defaults empty, so old checkpoints still parse. Add a test that loads a pre-change
  checkpoint shape.
- The offline kernel e2e (`tests/unit/kernel/kernel-e2e.test.ts`) stays $0 and green.

## Explicitly forbidden

- Having the LLM write `context`: code fills it from state.
- Passing the raw history to workers. Last 3 asks plus referents is the cap.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel
pnpm eval --suite understanding    # one paid run; follow-up cases before vs after
```

## Acceptance criteria

- Unit tests: extraction per entity type, resolution order, ambiguity → ask, done marker, old checkpoint compatibility.
- AG-030 cases #361, #382, #411, #525 and #561 pass on the live run.
- Real path: in Telegram, list PRs on Oplify, then ask "what repo are these on?". Reply and trace go in the PR body.
