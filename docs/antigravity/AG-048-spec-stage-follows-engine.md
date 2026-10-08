# AG-048 — The spec stage uses the chosen engine and reports a quota stop at once

**Source:** [docs/plans/2026-10-08-root-fix-task-list.md](../plans/2026-10-08-root-fix-task-list.md) task 12.
**Depends on:** AG-040 merged (job file replaces labels), because the failure is written to the job file.
**Branch:** `task/issue-<N>-spec-follows-engine`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: coding pipeline and third-party CLIs.
**Moves:** A. Needs the founder's yes on the root-fix list and the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

A `/task` keeps moving when one engine is out of quota, and the founder is told within a minute which engine stopped and
what ran instead.

## Problem / observed behavior

- `src/tools/pipeline-spec.ts:4`: "Pass P runs Claude (as `claude-agent` …)" on every job. `/engine` and the `engine`
  argument of `dispatch_antigravity_task` (`dispatch-antigravity.ts:263`) do not reach it.
- Prod 10-07, issue #1005: the spec job exited 1 on "You've hit your weekly limit · resets Oct 11". For 30 minutes the bot
  said "spec being drafted" because status reads labels.

## Expected behavior

1. The spec stage reads the engine recorded on the job (`engineLabel` / the AG-040 job file) and runs that engine.
2. When the engine's CLI exits with a usage-limit error, the stage retries once on the other engine and records both
   attempts in the job file.
3. A Telegram line goes out within 60 s of the first failure: "Spec: Claude is out of quota until Oct 11, running it on
   agy instead." If both engines fail, a typed failure with both reasons.
4. Detect the limit by exit code plus the CLI's own limit message. Put the matching in one tested function.

## Explicitly forbidden

- Silent fallback: the founder always sees which engine ran.
- Retrying the same engine in a loop.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/tools
```

## Acceptance criteria

- Failing test first: the job records engine `agy` and the spec stage spawns `agy`, not `claude`. It fails on `beta` today.
- The limit detector matches the 10-07 message and does not match an ordinary non-zero exit.
- Real path: one `/task` with `/engine agy` on prod. The job file shows a spec written by agy and Telegram shows the
  spec-done line.
