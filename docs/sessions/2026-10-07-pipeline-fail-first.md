# 2026-10-07 — coding pipeline v2: spec must fail first

## What we did
- #968 (fix/pipeline-spec-must-fail-first → beta) merged at a8851110 after all 8 CI checks passed on head c565e799. It closes three gaps from the first v2 run:
  1. Pass P runs the locked test on unchanged code. If the test already passes, the issue goes to `needs-brief` and no spec card is sent (`src/tools/fail-first.ts`, `deploy/lib/pass-p.sh` `pass_p_fail_first`).
  2. An executor run that commits nothing closes the empty PR, keeps the spec branch and labels `needs-brief` instead of `agent:failed` (`exec_changed_nothing` in `deploy/lib/executor-prompt.sh`).
  3. The executor prompt asks for `Moves: A`, and the dispatcher adds it when missing (`deploy/lib/pr-moves.sh`).
- Promotion #969 (`chore/promote-pipeline-fail-first` = origin/main + merge origin/beta). It also carried #957, #959, #961, #962 and #964, which were already gated on beta. No DB migrations.
- #969 merged on green at 30bb0780. CI on main passed, and Deploy run 37578513067 concluded `success` at 05:54:43Z. `founderos` restarted 05:56:15Z.
- On the VPS: `/opt/founderos` HEAD is 30bb0780. `deploy/lib/pass-p.sh` has `pass_p_fail_first` (3 hits). `deploy/lib/pr-moves.sh` exists, and sourcing both as `founderos` defines `ensure_moves_line` and `pass_p_fail_first`. `/tmp/ff-probe.sh` is deleted.

## Next live proof: one /task
The bug: `github` tool `list_issues` returns pull requests as issues. GitHub's `issues.listForRepo` includes PRs (items carrying `pull_request`), and `src/tools/github.ts` maps every item. First reported in the 2026-10-02 dispatch audit; still present on beta a8851110.

Red on beta, run locally ($0) with a throwaway test that was not committed, because the pipeline must write its own test and see it fail:
```
AssertionError: expected [ 1, 2 ] to deeply equal [ 1 ]
Tests  1 failed (1)
```
A one-line `filter((i) => !i.pull_request)` turned it and the existing `github.test.ts` green (20/20), then it was reverted. So the task can be done, and Pass P's fail-first check will pass.

## Why this bug
It needs a real code change, its test is deterministic and offline, and the fix is small enough that the run tests the pipeline, not the executor's skill.

## Outstanding
- NOT VERIFIED: the full flow (/task → spec card → Approve → executor commit → pr-brain review → evidence card with Merge → merge). Only the founder's `/task` starts it.
- Local full `pnpm test` still fails about 112 bash-harness tests under file parallelism on macOS (CI green). It has its own task.
