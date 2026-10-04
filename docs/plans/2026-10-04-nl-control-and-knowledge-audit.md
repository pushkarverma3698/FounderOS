# NL control + knowledge audit — plan and handoff (2026-10-04)

Goal (founder): run the whole product in plain language, with no daily friction. FounderOS must know what it
can do and remember what was said.

## State at handoff
- #857 (recurring scheduled tasks) and #858 (`/review on|off`) are merged to beta and promoted via #860
  (main ec8858db). Deployed: the service restarted 12:49:47 UTC.
- Branch `feat/conversation-recall` (from origin/beta) holds a local WIP commit: `src/kernel/turn-log.ts` (new),
  plus edits to `src/kernel/planner.ts` and `src/kernel/graph.ts`. Not pushed.

## Open bug: the live `/review` reply cannot show the models (Full depth: cron/daemons)
- Probe reply: `Could not read the models from the crontab: Command failed: crontab -l … fopen: Permission denied`.
  On/off itself is correct.
- Cause: the prod unit runs with `NoNewPrivileges=true`, so setgid `/usr/bin/crontab` (root:crontab, `-rwxr-sr-x`)
  loses its gid and cannot read `/var/spool/cron/crontabs/founderos` (dir `drwx-wx--T root crontab`).
- Fix (recommended): at the start of each run, `pr-brain` and `agent-dispatch` write their effective settings to
  `~/.claude/pr-brain.effective` and `~/.claude/agent-dispatch.effective`. These are KEY=value lines: REVIEW_MODELS,
  PR_BRAIN_MERGE, AGY_EXECUTOR_MODEL, CLAUDE_EXECUTOR_MODEL. `src/gateway/review-command.ts` reads those files
  instead of running `crontab -l`, and when a file is missing it still prints the reason. This also reports what
  actually ran, which a crontab parse cannot. Model variables: `deploy/vps-daemons/pr-brain:93`,
  `deploy/lib/agy-run.sh:45`, `deploy/lib/claude-run.sh:37`.
- Then re-probe: `/review`, `/review off`, `/review on` (command in "Live probe" below).

## Live checks still NOT VERIFIED
1. `/review` model lines (blocked by the bug above). `/review off|on` has not been probed live.
2. Recurring task: probe `every day at 09:00 send me a one-line motivation`, approve, then check that the
   `scheduled_tasks` row has a recurrence set.

Live probe: `ssh founderos-vps 'cd /opt/founderos && sudo -n -u founderos timeout 120 node --import tsx/esm --env-file=.env scripts/telegram-probe.ts "<msg>" 40'`
Prod SQL: write the file locally, then `ssh founderos-vps 'sudo -n docker exec -i founderos-postgres sh -c "psql -U \$POSTGRES_USER -d \$POSTGRES_DB -X"' < file.sql`

## Knowledge audit findings
| # | Finding | Fix | PR |
|---|---------|-----|----|
| a | No durable conversation log: anything said before the last 6h of silence cannot be recalled | TurnLog → `episodic_memory` rows (event_type `conversation`, tag `turn:<id>` for idempotency) + read-only `recall_conversation({since, until?, query?})` admin tool + planner hint | 1 (WIP) |
| b | Each founder message cut to 600 chars in history | Raised to 2000 (`HISTORY_INPUT_MAX_CHARS`) | 1 (WIP) |
| c | Self-description (`founderos_departments` in founder_context) is hand-written and drifting; it doesn't know the review switch, the models, or the VPS jobs | Derive it from `src/agents/capabilities.ts`; expose background jobs and switches (pr-brain, agent-dispatch, journeys, scheduler sweeps) as a read-only tool | 2 |
| d | RAG ranking has no recency weight; 310 of 763 plan chunks are older than 30 days and still ACTIVE | Recency decay in ranking; mark superseded plans | 3 |
| e | `search_memory` type `conversations` reads the dead `conversations` table | Point it at the turn log (after #1) | 1 or 2 |
| f | `knowledge_entries` has no embeddings (`brain_memories`, which agents search, has none missing) | Low priority | later |
| g | personal_rag is a 4-row stub, not bound to anything | Ask the founder before filling it | later |

## Remaining steps for PR 1 (`feat/conversation-recall`)
1. Export `TurnLog` from `src/kernel/index.ts`. Add an infra module with an idempotent `recordConversationTurn` and a
   `listConversationTurns(since, until, query)` that use `getDb` + `episodicMemory` directly. Don't touch
   `src/db/queries.ts` (2334 lines), and don't import kernel from infra.
2. Add the `recall_conversation` tool in `src/agents/agent-tools/memory.ts` and register it in the admin list in
   `capabilities.ts:124`.
3. Wire `turnLog` in `kernel-boot.ts` with a fail-open adapter tagged `// allow-failopen:`, following the
   `buildLessonStore()` pattern. Don't add to `kernel-run.ts`: it is 398 lines.
4. Tests first: the plan node records the previous turn once with the thread_id; the 2000 cap; the tool output format.
5. `pnpm gate`. Draft PR to beta with `Moves: unfreeze` plus the `unfreeze` label (founder-approved), then probe
   live: "what did I ask you yesterday".
