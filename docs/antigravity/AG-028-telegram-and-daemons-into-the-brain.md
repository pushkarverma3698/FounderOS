# AG-028 — Telegram turns, daemon messages and VPS Claude sessions reach the brain

**Source:** [docs/plans/2026-10-06-one-brain-context-audit.md](../plans/2026-10-06-one-brain-context-audit.md): H5, group and pr-brain sessions at 0 rows, Mac Claude blind to Telegram.
**Depends on:** AG-026 merged. AG-027's scrubber and visibility filter merged, or built here if AG-027 is not.
**Branch:** `task/issue-<N>-telegram-into-brain`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full. It changes when turns are recorded, adds a scheduled job, and handles group-chat privacy.
**Moves:** B. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

Within 15 minutes of a Telegram reply, Mac Claude's `search_memory` can find it, with its date and chat. The latest turn of a
chat is never missing from the turn log. pr-brain verdicts and dispatch alerts outlive the 12 h screen window.

## Problem / observed behavior

- **Turn log lags one turn:** `src/kernel/planner.ts:290-292` records the previous turn only when the next one starts. Prod
  2026-10-06: DM checkpoints run to 14:12, `conversation_turns` stops at 11:50. The family group `-5319642142` has 11 checkpoints
  (latest 13:47) and 0 turn rows.
- **The hub can't see Telegram:** the MCP hub reads only `brain_memories` (`src/mcp/brain-tools.ts:108`). Nothing copies
  `conversation_turns` there, so Mac Claude can't see what the founder asked Telegram.
- **The screen log expires:** `~/.claude/screen.jsonl` (daemon sends: pr-brain, agent-dispatch, agy progress) is read for the
  last 12 h only (`src/kernel/screen.ts:23-25`). After that, "what was PR 79's verdict yesterday" has no source.
- **VPS Claude sessions are invisible:** pr-brain's Claude sessions under `/home/founderos/.claude/projects/` reach no brain.

## Expected behavior

1. **Record at turn end.** When `runKernelText` (`src/gateway/kernel-run.ts:150`) or `resumeKernel` (`:270`) finishes a turn that has a reply and is not paused on HITL, it writes the turn with
   `recordConversationTurn`. The planner's fold at `:292` stays as a safety net. The table is already unique on
   `(thread_id, turn_id)` with `onConflictDoNothing` (`drizzle/0043_conversation_turns.sql`,
   `src/db/conversation-turns.ts:72`), so the second write is a no-op.
2. **Turns into the brain.** A maintenance job every 15 minutes, registered in `src/infra/scheduler.ts` like the existing
   maintenance jobs, copies new turns into the brain:
   - one row per turn: `memory_type: conversation`, `source: telegram`, `source_id = <thread_id>:<turn_id>`;
   - content `Founder: <input>\nFounderOS: <reply>`;
   - `origin: telegram`, `occurred_at` = the turn time;
   - `visibility`: `founder` for the founder DM, `all` for group chats.

   The cursor is the newest `occurred_at` already copied. Read it back from the brain; add no state table.
3. **Screen entries into the brain.** The same job copies screen-log entries older than 1 h:
   - `origin: vps-daemon`, `memory_type: event`, `source_id` = sha256(chat + time + text);
   - `visibility` per chat, as above;
   - first through the AG-027 scrubber.
4. **VPS Claude sessions.** The job runs the AG-027 digest over `/home/founderos/.claude/projects/` and ingests the result with
   `origin: vps-claude`. Reuse `brain-capture.ts`; don't fork it.
5. **Fail loud.** Every job failure logs at warn level with the stage. Catches carry `// allow-failopen: <reason>` (anti-slop
   rule 5), because a reply must never wait on the brain.

## Evidence

Prod SQL and checkpoint counts, 2026-10-06. Code read on `origin/main` at `f74e3262`.

## Files or subsystem in scope

`src/gateway/kernel-run.ts` (turn-end write), `src/kernel/planner.ts` (comment only), `src/infra/scheduler.ts`, a new
`src/infra/brain-feed.ts` (the job, kept under 400 lines), `src/db/conversation-turns.ts` (read since a time), tests.

## Constraints

- The reply path's latency must not change. Brain writes happen only in the job, never in the turn.
- Group rows are `visibility: all` because the group already sees them. DM rows are `founder`.
- **Embedding goes through Ollama.** If it is down, the job leaves the cursor and retries next run. No row is written
  without an embedding.

## Explicitly forbidden

- Writing brain rows inside the Telegram reply path.
- A new table for cursors or state.
- Copying group-chat turns into the founder DM context, or the reverse.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/gateway tests/unit/infra tests/unit/kernel
```

## Acceptance criteria

- **Unit tests:**
  - a completed turn is written once even when the next turn also folds it;
  - a paused (HITL) turn is not written;
  - the job copies 3 turns, and a second run copies 0.
- **Prod SQL after deploy:** the group's next turn has a `conversation_turns` row within a minute, and a brain row with
  `origin = telegram` within 15 minutes.
- **Live path:** from Mac Claude, hub `search_memory "PR 79"` returns the 10-06 Telegram turn with its date. If not run:
  NOT VERIFIED with the reason.
