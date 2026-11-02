# AG-056 — Coding engine fallthrough and honest job status

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-056.
Absorbs AG-048 (spec stage follows engine). Read that brief: its expected behavior and tests carry over unchanged.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-engine-fallthrough`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: cross-process pipeline, retries, messages sent to the founder.
**Moves:** A.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

A coding task keeps moving when one engine is out of quota, and every status answer about a job comes from the job's
row, never from a label or a guess.

## Problem (measured)

- Pass P, the spec stage, always runs Claude as `claude-agent` (`src/tools/pipeline-spec.ts:4`,
  `deploy/lib/pass-p.sh:216`), whatever `/engine` says.
- The VPS Claude CLI hit its weekly limit on 10-07/10-08 (resets 10-11). Every spec job died, and agy was never tried.
- `deploy/lib/engine.sh` already records a Claude block (`record_claude_block`, `claude_blocked`) and an agy one
  (`agent-dispatch.down`, `agent-dispatch.quota-until`). Nothing uses those walls to pick the other engine.
- After the failure the bot told the founder "the spec is being drafted": status was read from labels, not from the
  job's result.

## Expected behavior

1. **AG-048 items 1 to 4:** the spec stage runs the job's engine, retries once on the other engine when the first one
   hits a usage limit, and sends one Telegram line within 60 s naming which engine stopped and which ran.
2. **Same wall check at dispatch.** When the chosen engine is blocked (`claude_blocked`, or the agy down/quota files)
   at start time, the job starts on the other engine and the reason goes into the job row and the dispatch message.
   One tested function decides this: `pick_engine(chosen, claude_wall, agy_wall)`.
3. **Status reads the job row.** `antigravityTaskStatus` (`src/agents/agent-tools/antigravity-followup.ts`) and any
   other status reply read the job row's state and last error. A failed job says "failed: <reason>" with the reset
   time if there is one.
4. **Both engines down** gives a typed failure that names both reasons. The job is not left `queued`.

## Files in scope

`deploy/lib/engine.sh`, `deploy/lib/pass-p.sh`, `deploy/lib/claude-run.sh`, `deploy/lib/agy-run.sh`,
`deploy/agent-dispatch`, `src/tools/pipeline-spec.ts`, `src/agents/agent-tools/antigravity-followup.ts`, tests in
`tests/unit/scripts/` and `tests/unit/tools/`.

## Constraints

- Never edit `/opt/founderos`. The bash libs reach the VPS through deploy.
- No silent fallback: the founder always sees which engine ran.
- One retry, never a loop.
- Bash 3.2 safe: the Mac gate runs these libs (see #980).

## Explicitly forbidden

- A third engine.
- Clearing a block file to "unstick" a job.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/scripts tests/unit/tools
```

## Acceptance criteria

- Failing tests first:
  - `pick_engine claude <blocked> <ok>` prints `agy`.
  - The limit detector matches the 10-07 message ("You've hit your weekly limit · resets Oct 11") and does not match
    an ordinary exit 1.
  - The status tool returns "failed" for a failed job row.
- On prod while the Claude limit holds (until 10-11): one `/task` on FounderOS. Paste the Telegram line naming agy, the
  job row and the spec PR or issue comment. After 10-11, write NOT VERIFIED for the reverse direction (agy down).
