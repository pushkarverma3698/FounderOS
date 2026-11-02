# AG-040 — A job file replaces the agent:* labels; review and fix rounds run inside the job (direct-run PR 3)

**Source:** [docs/plans/2026-10-08-daily-driver-plan.md](../plans/2026-10-08-daily-driver-plan.md); memory `direct-run-pipeline-proposal-2026-10-07` PR 3.
**Depends on:** AG-039 merged to beta (same scripts).
**Branch:** `feat/job-file-replaces-labels`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full (cron, daemons, merge path). Follow `~/.claude/skills/production-ready/SKILL.md`.
**Moves:** A.

## Goal
One `/task` = one job that owns spec → build → review → up to 2 fix rounds → merge card. Job state lives in one file per job, not in GitHub labels. The sweep crons that existed to move labels are deleted.

## Problem
- State is spread over six `agent:*` labels, contract files and markers; the 15-minute `agent-dispatch` sweep and the 20-minute `pr-brain` sweep move it. Fix rounds after a REQUEST_CHANGES verdict only run in the sweep (`redispatch_unresolved_reviews`), and the sweep's review is off while `pr-brain.off` exists, so a "changes requested" PR stalls silently.
- Beta is `strict`: any beta merge makes an open job PR BEHIND; a card made against the old base is refused (#988 handles part of it).
- `deploy/agent-dispatch` (~1,560 lines) + `deploy/vps-daemons/pr-brain` (~1,520 lines) + `deploy/job-run`: most of the size is sweep/label plumbing.

## Expected behavior
1. `~/.claude/jobs/<owner>__<repo>__<issue>.json` (atomic write: temp + rename) holds `{repo, issue, stage, pr, head, round, status, updatedAt, lastError}`. `deploy/job-run` reads and writes it; it is the only state. Labels may stay as human-readable decoration but nothing reads them for control flow.
2. After build, `job-run` runs `pr-brain --pr N`. On REQUEST_CHANGES it runs one fix round for that PR (reuse the existing fix/redispatch code path, do not write a new executor call), then re-reviews. At most 2 rounds; then the card says what is still failing and asks the founder.
3. Before sending a merge card, if the PR is BEHIND its base, `gh pr update-branch`, wait for CI (bounded), then card. The card names its PR (already true after #988; keep it).
4. Delete: the `*/15` agent-dispatch sweep cron line (sync-daemons removes it from the VPS crontab like #990 did for `--kicked`), sweep-only code paths in `agent-dispatch` and the job-PR sweep in `pr-brain`. Keep `pr-brain --pr N` and keep pr-brain's sweep only for PRs no job owns (human/other PRs), if that path is still used — justify in the PR body.
5. The spec-approval callback (`src/gateway/coding-callbacks-live.ts`) and `dispatch-tick.ts` keep sending `stage=build` over `/run/fos-job.sock`; if they read labels for state, switch them to the job file or to the job's reply.

## Constraints
- Exactly one founder-visible outcome per job (card or the single failure message), as #990 built.
- Net lines in `deploy/` must go **down**. Report the before/after `wc -l` in the PR body.
- HITL unchanged: merge only after the founder's tap on the card.

## Explicitly forbidden
- New alerts that detect a stall instead of removing the stall.
- New labels, new cron lines, new daemons.

## Verification commands
- Failing tests first for: fix round triggered by REQUEST_CHANGES, round cap of 2, BEHIND → update-branch → card, job file atomic write, sweep cron removal in sync-daemons.
- `pnpm lint && pnpm verify:arch && pnpm verify:doc-claims` + touched tests. Mac bash-harness noise is expected; ubuntu CI is the check.
- No live runs; the orchestrator runs a real /task after deploy.

## Acceptance criteria
- `crontab` template has no agent-dispatch sweep line; a job with a REQUEST_CHANGES verdict gets a fix round without any cron.
- PR body: What changed · How it was verified · NOT VERIFIED, `Moves: A`, and the `wc -l` delta.
