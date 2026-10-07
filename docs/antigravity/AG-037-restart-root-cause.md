# AG-037 — A deploy never drops a turn the founder is waiting on

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 8.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-deploy-drains-turns`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: deploy, process lifecycle, concurrency.
**Moves:** A. Label `crash-fix`.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

A message sent while FounderOS restarts gets an answer, or an explicit "I restarted mid-answer; send it again". Today it
gets silence, which reads as "it ignored me".

## Problem / observed behavior

- `founderos.service` stopped 86 times from 10-01 to 10-07. All were clean `systemctl restart` calls: 78 from
  `PWD=/opt/founderos` (deploy), 7 from a shell. The Deploy workflow ran 81 times in the same window. These are deploys,
  not crashes.
- `shutdown()` in `src/index.ts:133-141` closes health, stops the bot, closes the DB and exits. No step in it waits for kernel runs
  in flight (check whether `stopBot()` does before building), and `TimeoutStopSec=30` (`deploy/founderos.service:55`) is shorter than the turn p90 (55 s) and far shorter than
  the max (270 s).
- Turns #360 and #378 got no reply and no HITL resume. **Hypothesis:** they overlapped a deploy. Confirm or reject this from
  the journal timestamps first.

## Expected behavior

1. **Confirm the cause.** For #360 and #378 (audit §4), and every DM `turn.in` in the last 30 days without a matching
   `turn.out`, check whether a `Stopping founderos.service` falls between `turn.in` and the next start. Paste the table in
   the PR body.
2. **Drain.** On SIGTERM: stop taking new updates, then wait up to 25 s for in-flight kernel runs (a counter around the
   kernel invoke in `kernel-run.ts`), then exit.
3. **Tell the founder.** A run still in flight at exit writes a row (existing table if one fits; grep `pending` and
   `stranded` first). On the next boot, the founder gets one message per dropped turn: `I restarted while answering
   "<first 60 chars>". Send it again.` HITL-paused runs are excluded; they resume from the checkpointer already.
4. **Fewer restarts:** if two deploys land within 2 minutes, the deploy script restarts once (check `deploy.yml`
   concurrency first; it may already cancel).

## Files or subsystem in scope

`src/index.ts`, `src/gateway/kernel-run.ts`, boot path in `src/gateway/`, `.github/workflows/deploy.yml` (only if item 4
needs it), tests.

## Constraints

- Never edit `/opt/founderos` or restart prod by hand. The deploy is the test.
- `TimeoutStopSec` stays ≥ drain time + 5 s; change the unit file only if needed, in this PR.
- The "send it again" message is idempotent: one per dropped turn, keyed by turnId.

## Explicitly forbidden

- Replaying the dropped message automatically: it may have been a side-effecting ask.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/gateway tests/unit/infra
```

## Acceptance criteria

- The cause table from item 1.
- Unit tests: drain waits for an in-flight run, times out at 25 s, records the dropped turn; boot notice sent once.
- Real path after deploy: send a message, then trigger the next deploy while it runs. You get the reply or the "send it
  again" notice. If no deploy can be timed, write NOT VERIFIED.
