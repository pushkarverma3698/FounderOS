# AG-060 — One coding pipeline path

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-060.
Absorbs AG-039 (one token, one repo list), AG-040 (job file replaces labels) and the dispatch half of the direct-run
proposal. AG-041 (promote from Telegram) follows on the same path afterwards. Read all three briefs; their problem
sections and tests carry over.
**Depends on:** AG-056 (engine fallthrough).
**Branch:** `task/issue-<N>-one-pipeline-path`, cut from `origin/beta`. PR base: `beta`. Expect 2 or 3 PRs, in the order
below.
**Depth:** Full: cross-repo contract, tokens, cron, retries.
**Moves:** A.

Read [STANDARDS.md](STANDARDS.md), `.claude/rules/prod-vps.md` and `~/.claude/skills/production-ready/SKILL.md` first.

## Goal

A `/task` (or "get an agent on issue 123") is one job row. That row owns spec, build, review, up to 2 fix rounds and the
merge card. GitHub labels and sweep crons no longer carry state.

## Problem (measured)

- Two tokens and two repo lists: `DEFAULT_REPOS` in `deploy/agent-dispatch` and `DISPATCH_REPO_ALLOWLIST` in
  `src/tools/dispatch-repos.ts`. Oplify was invisible to the daemons for a day (606 "Could not resolve" lines) with no
  founder-visible signal.
- State lives in six `agent:*` labels, plus markers and contract files. Two sweeps move it: `agent-dispatch` every
  15 minutes and `pr-brain` every 20.
- `deploy/` holds 3,632 lines of bash libs and dispatch scripts. Most of it is sweep and label plumbing.
- Every pipeline PR this week (12 of them) patched a seam between those parts.

## Expected behavior

**PR 1: one token, one repo list (AG-039).** One list in `src/tools/dispatch-repos.ts`, which the bash reads through a
generated file at deploy. One GitHub token for every coding call. A `/task` on a repo the token cannot reach is refused
in chat before anything is filed.

**PR 2: the job row owns the state (AG-040).**
- One row per job, with stage, engine, attempts, last error, PR number and base SHA. Use the existing jobs table if
  one fits.
- `deploy/job-run` advances it.
- Fix rounds start from the review verdict event, not from a sweep.
- Labels become a one-way mirror that people can read. No code reads them.

**PR 3: delete the sweeps.** Delete `redispatch_unresolved_reviews` and the label-moving parts of `agent-dispatch` and
`pr-brain`, once 3 jobs have run end to end on the job row. Count the lines deleted.

## Files in scope

`deploy/agent-dispatch`, `deploy/vps-daemons/pr-brain`, `deploy/job-run`, `deploy/lib/*.sh`,
`deploy/onboard-repo.sh`, `src/tools/dispatch-*.ts`, `src/tools/pipeline-*.ts`,
`src/agents/agent-tools/antigravity-followup.ts`, `src/db/schema.ts` (job row), tests.

## Constraints

- Never edit `/opt/founderos`. Everything reaches the VPS through deploy.
- Bash 3.2 safe.
- One writer per branch: check `~/Projects/scripts/ai-tools/agy-guard` before touching a tree an agent holds.
- `PR_BRAIN_MERGE=0` stays. The founder taps merge.
- Journey J4 runs after each PR.

## Explicitly forbidden

- Keeping a label as a second source of truth.
- A new daemon.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/scripts tests/unit/tools
```

## Acceptance criteria

- PR 1: a `/task` on a repo outside the list is refused in chat (paste it), and the Oplify issue list is reachable by
  the daemon token (paste `gh api` output with the token's user, never the token).
- PR 2: one real `/task` goes from spec to merge card with no label read. Paste the job row at each stage.
- PR 3: `wc -l` of `deploy/` before and after, and J4 green for 2 mornings.
