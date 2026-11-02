# 2026-10-13: OpenDots setup simplified, research-first rule, privileged computers

## Outcome
Each Dot now leads claude/agy in its own computer and uses the app's own scheduled tasks. The GitHub-label
pipeline that duplicated those features is gone. Every computer runs privileged, so Postgres, Redis and
docker work inside it. A rule with a CI check makes agents check what exists before they build. PRs: FounderOS
1171 (promoted in 1172), 1173 (promoted in 1174). Live proofs are in the comments on 1171 and 1173.

## What changed
- Removed: team-shift, chief-run, team-lib.sh, team-stream, team/*.md, shift-cron, shift-notify, add-dot.sh,
  seed-cli-logins.sh, and `dot-task loop*`. CI tombstones the paths.
- setup-dots.sh: every Dot leads claude/agy through run-bg; a brief asks what already exists; a rerun removes
  the old cron lines and cancels the old shift tasks.
- opendots-turicks.patch: privileged computers; `SCHEDULED_MODEL_CALLS = 30`.
- `dot-task show <id>` reads a task's newest run. The DevOps prompt says never wait on a run you queued.
- Research-first rule: `~/.agents/AGENTS.md` (Judgment), CLAUDE.md #25, the PR template, and the Dot prompts.

## Which layer enforces each guardrail
| Guardrail | Layer |
|---|---|
| A PR adding a code or script file says what was checked first | CI: `verify-pr-scope.ts` ("Checked first:" ≥ 20 chars), FounderOS only |
| Retired pipeline files stay deleted | CI: tombstones |
| A Dot checks what exists before it builds | Prompt only |
| A Dot never waits on a task it queued | Prompt only; the app's one-task-at-a-time runner makes waiting fail |

## Found on the way
- The app runs one task at a time (`runner.ts`: `if (this.active.size) return;`). A Dot's turn is a task, so
  a run it queues starts only after the turn ends. DevOps waited, used up its 30 calls, and failed.
- `GET /api/tasks/:id` lists runs newest first.
- CopilotKit Intelligence returned 503 from 13:05:36Z to 13:05:48Z. A turn running then failed with "Run ended
  without emitting a terminal event", and a routine failed with "Failed to initialize thread". Both failures
  were upstream; a retry worked.

## Strongest argument against, stated before building
The label pipeline gave the founder a queue he could see on GitHub. Without it, work lives in conversations
and scheduled tasks, which show in the app but not on GitHub.

## Open
- The Checked-first CI covers FounderOS only, not Oplify.
- Draft pushkarverma3698/opendots-sandbox#56 (lower command) is open from the live proof.
- Routine 356bfeb9 (disk and memory, every 6 h) is live in the app.
