# AG-041 — Promote beta to prod from Telegram, with the deploy check

**Source:** [docs/plans/2026-10-08-daily-driver-plan.md](../plans/2026-10-08-daily-driver-plan.md) goal 1.
**Depends on:** nothing.
**Branch:** `feat/promote-from-telegram`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full (merges to main, deploy). Follow `~/.claude/skills/production-ready/SKILL.md`.
**Moves:** A.

## Goal
The founder types `/promote` (or "ship beta to prod") and, after one tap, gets beta onto prod and a message saying the deploy moved and the service is healthy, without a laptop.

## What already exists (do not rebuild)
- Socket-activated jobs: `deploy/systemd/fos-job.socket` + `fos-job@.service` + `deploy/job-run` (one JSON line in, one founder-visible outcome out, EXIT trap). The bot writes to `/run/fos-job.sock` from `src/tools/dispatch-tick.ts`.
- Deploy: `.github/workflows/deploy.yml` deploys on push to `main`. `.github/workflows/sync-beta.yml` syncs main → beta.
- HITL cards and callbacks: `src/infra/hitl.ts`, `src/gateway/coding-callbacks-live.ts` (merge card pattern).
- Promotion rules (founder, binding): build the branch as `origin/main` + `git merge origin/beta` named `chore/promote-<slug>`; merge with a **merge commit** (`gh pr merge --merge`), never squash; no re-review; merge on green CI.

## Expected behavior
1. `/promote` (owner-only command in `src/gateway/commands.ts`, plus the planner routing plain words like "promote beta" / "ship to prod" to it as a planned command, not a model write path). It lists the PRs on beta not on main (GitHub compare API, read-only) and sends a HITL card: "Promote N PRs to prod? #a title, #b title …". Nothing to promote → says so, no card.
2. On approve, the bot sends `{"repo":"pushkarverma3698/FounderOS","stage":"promote"}` over `/run/fos-job.sock`. Extend `deploy/job-run` validation for `stage=promote` (issue not required for this stage) and call a new small script `deploy/promote-run`.
3. `deploy/promote-run`, in a scratch clone/worktree it owns (never `/opt/founderos`): fetch; branch `chore/promote-<UTC yyyymmdd-hhmm>` = origin/main + merge origin/beta. A conflict ends the job with the conflicting file list. Push, open the PR to main with What changed (the PR list) / How it was verified (each PR passed its own gate) / NOT VERIFIED (deploy, checked next) and `Moves: A`. Wait for required checks (bounded, ~30 min). Green → `gh pr merge --merge`. Then wait for the Deploy workflow run on that merge commit (bounded) and check on the box: `/opt/founderos` HEAD == merge commit and `systemctl is-active founderos` = active.
4. One outcome message: "Prod is now <sha7> (N PRs), service active" or the single failure message with the stage it died in (CI red with failing check names, conflict, deploy failed, HEAD did not move).
5. Concurrency: one promotion at a time (lock); a second `/promote` while one runs says "already promoting since <time>".

## Constraints
- Use the bot's `GITHUB_TOKEN` for gh (match AG-039 if it lands first; otherwise the same env-file source the other daemons use).
- Never write to `/opt/founderos`; read its HEAD only.
- Unit-test the pure parts: request validation, card text from a compare result, outcome text per failure stage.

## Explicitly forbidden
- Squash merges; merging on red or pending CI; skipping the founder tap.

## Verification commands
- Failing tests first; `pnpm lint && pnpm verify:arch && pnpm verify:doc-claims` + touched tests. Mac bash-harness noise is expected.
- No live runs; the orchestrator runs the first real `/promote` after deploy.

## Acceptance criteria
- From Telegram: `/promote` → card → tap → prod HEAD moves → one message with the new sha. Proven by the orchestrator after deploy.
- PR body: What changed · How it was verified · NOT VERIFIED, `Moves: A`.
