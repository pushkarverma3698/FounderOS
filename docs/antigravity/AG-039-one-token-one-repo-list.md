# AG-039 — One GitHub token, one repo list, /task refuses an unreachable repo (direct-run PR 2)

**Source:** [docs/plans/2026-10-08-daily-driver-plan.md](../plans/2026-10-08-daily-driver-plan.md); memory `direct-run-pipeline-proposal-2026-10-07` PR 2.
**Depends on:** nothing (PR 1 = #990 is on prod).
**Branch:** `feat/one-token-one-repo-list`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full (tokens, deploy daemons, cross-repo). Follow `~/.claude/skills/production-ready/SKILL.md`.
**Moves:** A.

## Goal
Every GitHub call the coding path makes uses one token and one repo list, and a `/task` on a repo that token cannot reach is refused in the same chat before anything is filed.

## Problem
- 10-06→10-07: the daemons (founderos and antigravity users) used a fine-grained PAT scoped to one owner, while the bot used a classic `GITHUB_TOKEN`. Oplify was invisible to the daemons for a day: 606 "Could not resolve to a Repository" log lines, zero founder-visible signal.
- Two repo lists: `DEFAULT_REPOS` in `deploy/agent-dispatch:115` and `DISPATCH_REPO_ALLOWLIST` in `src/tools/dispatch-repos.ts`. `deploy/onboard-repo.sh:296` parses the bash one.

## Expected behavior
1. `deploy/agent-dispatch`, `deploy/vps-daemons/pr-brain`, `deploy/job-run` export `GH_TOKEN` from the bot's `GITHUB_TOKEN` (read from the env file they already source, `AGENT_DISPATCH_ENV_FILE` / `PR_BRAIN_ENV_FILE`) for every `gh` and `git` call. `git push` uses it through a credential helper that reads the env var, never a URL with the token in it.
2. The token reaches the `antigravity` shell (`sudo -n -u antigravity …`) on **stdin or an inherited fd**, never argv (argv is world-readable in `/proc`). A test asserts no `sudo … GH_TOKEN=` / token-in-argv pattern exists in those scripts.
3. `DEFAULT_REPOS` is deleted. The bash daemons get the repo list from `src/tools/dispatch-repos.ts` (e.g. a tiny `scripts/print-dispatch-repos.ts` run with `node --import tsx/esm`, or another single-source mechanism you justify). `onboard-repo.sh` reads the same source. No CI check that compares two lists: there must be only one list.
4. `/task` (`src/tools/dispatch-antigravity.ts`, `src/tools/dispatch-spec-intake.ts`): before filing the issue, call `repos.get` with the bot's token. On 404/403 or missing push permission, file nothing and reply with: the repo, GitHub's status and message, and "the bot's GITHUB_TOKEN cannot reach this repo". Pure decision function, unit-tested.
5. Delete what this replaces: per-user `gh auth` reliance in the scripts, any comment/README text describing two lists or two tokens. Update `deploy/vps-daemons/README.md`.

## Constraints
- Do not create, rotate or print tokens. Tests use fake values.
- One founder-visible outcome per job stays as #990 built it (`deploy/job-run` EXIT trap). Add no new per-error alerts.
- Keep the 15-minute sweep cron working (AG-040 removes it later).

## Explicitly forbidden
- A second copy of the repo list, or a check that two lists match.
- Token in argv, URLs, logs, or the PR body.

## Verification commands
- Failing tests first (bash harness in `tests/unit/scripts/`, vitest for the TS side), then green.
- `pnpm lint && pnpm verify:arch && pnpm verify:doc-claims` and the touched test files. On the Mac, bash-harness tests can fail as noise (GNU date, bash 3.2); ubuntu CI is the real check.
- Do NOT run live probes or touch the VPS; the orchestrator does the live run after deploy.

## Acceptance criteria
- `grep -rn DEFAULT_REPOS deploy src` returns nothing.
- A `/task` on a repo the token can't see is refused in chat (unit test on the decision + the tool wiring).
- PR body: What changed · How it was verified · NOT VERIFIED, plus `Moves: A`.
