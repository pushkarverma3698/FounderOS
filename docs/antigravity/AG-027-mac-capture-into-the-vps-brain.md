# AG-027 — Mac Claude memory, Claude sessions and Antigravity work reach the VPS brain every 30 minutes

**Source:** [docs/plans/2026-10-06-one-brain-context-audit.md](../plans/2026-10-06-one-brain-context-audit.md): Mac sources at 0 rows, H6, F1, F3–F7.
**Depends on:** AG-026 (provenance fields) merged.
**Branch:** `task/issue-<N>-mac-brain-capture`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full. Cross-machine data, secrets risk, a new scheduled job, and new rows that group chats could read.
**Moves:** B. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

Within 30 minutes of a Mac session ending, its digest is in `brain.brain_memories` on the VPS, tagged with origin,
repo, branch, date and `visibility: founder`. Mac memory files and Antigravity conversations arrive the same way.
`/where` shows when capture last ran.

## Problem / observed behavior

- Measured 2026-10-06, all with 0 brain rows:
  - `~/.claude/projects/*/memory/*.md`: 18 dirs (founderos 176 files).
  - `~/.claude/projects/*/*.jsonl`: 636 transcripts, 228 from the last 7 days, 1.4 GB.
  - `~/.gemini/antigravity/conversation_summaries.db`: 273 conversations. Columns: `conversation_id, title, preview,
    step_count, last_modified_time, workspace_uris, status, raw_summary`.
  - `~/.gemini/antigravity/brain/<id>/`: `implementation_plan.md` ×82, `walkthrough.md` ×62, `task.md` ×56.
- `scripts/ingest-claude-sessions.ts` exists but is manual. It writes the laptop's own Postgres, a copy nothing
  reads (`~/Projects/scripts/ai-tools/founderos-brain-mcp.sh:12-15`). It sets no `project` (`storeDocument`, `:143`).
- `scripts/sync-conversation-session.ts` reads only `USER_INPUT` lines and writes no embedding. Its only caller was disabled 08-21.
- The Mac crontab runs `~/Projects/scripts/ai-tools/brain-auto-ingest.sh` at 02:00. That script fails every night and
  logs ✅: `brain:sync` refuses off the VPS, and `personal:sync` errors are hidden by `2>/dev/null || echo skipped`.

## Expected behavior

1. **Mac side, no database:** `scripts/brain-capture.ts` emits JSONL records
   `{ source, source_id, memory_type, project, content, metadata }` to stdout. No LLM, $0.
   - **memory files:** `memory_type: claude_memory`, `source_id` = sha256 of the file path. Plus one manifest record per project
     listing the paths present, so the VPS can archive deleted files.
   - **Claude sessions:** `memory_type: session`, `source_id` = session id. Content, capped at 4,000 chars:
     - title (`custom-title`, else the first founder prompt, 120 chars);
     - repo (from `cwd`), branch and PR links;
     - start and end time in `APP_TIMEZONE`;
     - up to 10 founder prompts (300 chars each);
     - the files passed to Edit/Write;
     - the final assistant message (1,200 chars).

     **Never tool results** (F1). Reuse `distillSession` (`src/lib/claude-transcript.ts:108`); do not write a second parser.
   - **Antigravity:** `memory_type: session`, origin `mac-agy`. Content: title, preview, step count, workspace, last modified,
     and the conversation's `walkthrough.md` (else `implementation_plan.md`), capped. Read the db with the macOS `sqlite3` CLI or
     `node:sqlite`; add no npm dependency. Skip `raw_summary` unless you show in the PR that it decodes to text.
   - **project:** from the path. `~/Projects/<name>/` gives `<name>`, `~/Oplify.in/` gives `oplify`, anything else gives `null`.
   - **Every record:** `visibility: founder`, plus `origin`, `machine`, `session_id`, `repo` and `occurred_at` (AG-026 shape).
2. **Secrets (F5):** a scrubber runs on every record before output. It covers API key prefixes (`sk-`, `ghp_`, `github_pat_`, `xox`,
   `AKIA`), PEM blocks, JWTs, `scheme://user:pass@`, `Bearer …`, and `NAME=value` lines whose name contains KEY, TOKEN, SECRET or PASSWORD.
   A record that matches is **dropped**. Its path (never its content) goes into the run summary.
3. **VPS side:** `scripts/brain-ingest-digests.ts` reads JSONL on stdin, validates each record with Zod, runs the same scrubber
   again, and calls `brainIngest`, upserting on (`source`, `source_id`). It archives memory rows whose path is missing from
   that project's manifest. At most 200 records per run, so the first backfill spreads over several runs. It prints one summary line.
4. **Transport:** `scripts/mac/brain-capture.sh` runs
   `node --import tsx/esm scripts/brain-capture.ts --since-state | ssh founderos-vps '<run brain-ingest-digests as founderos in /opt/founderos>'`.
   The Mac keeps a state file `~/.claude/brain-capture-state.json` (path → mtime + hash). It never holds database credentials.
5. **Schedule:** `deploy/mac/com.founderos.brain-capture.plist` (launchd, every 1,800 s) and `scripts/mac/install-brain-capture.sh`,
   which loads the plist. The install script also removes the `brain-auto-ingest.sh` crontab line, with a backup of the crontab.
6. **Group privacy (F3):** in the same PR, `search_knowledge` excludes `metadata.visibility = 'founder'` rows unless the run's
   `thread_id` is the founder DM. Take the thread from `config.configurable.thread_id`, as `src/tools/memory.ts` does. The hub
   (Mac, founder only) sees everything.
7. **Heartbeat (F7):** `/where` (`src/gateway/where-command.ts`) prints `Mac capture: last <n> min ago, <m> rows today`, from
   `max(created_at)` of rows with `metadata.origin` in (`mac-claude`, `mac-agy`). It shows ⚠️ when the last capture is older than 2 h. No new table.

## Evidence

Counts measured on the Mac and prod 2026-10-06. Code read on `origin/main` at `f74e3262`.

## Files or subsystem in scope

New: `scripts/brain-capture.ts`, `scripts/brain-ingest-digests.ts`, `scripts/mac/*.sh`, `deploy/mac/*.plist`, a scrubber module
under `src/lib/`. Edited: `src/lib/claude-transcript.ts` (reuse only), `src/tools/knowledge.ts`, `src/db/rag-search.ts`
(visibility filter), `src/gateway/where-command.ts`. Tests for the scrubber, the digest and the visibility filter.

## Constraints

- **Scrubber tests** use real-shaped fake secrets, one per pattern, plus clean text that must pass.
- **Digest tests** are fixture-based. Build a small `.jsonl` fixture from the documented line types (`custom-title`, `pr-link`,
  user, assistant, tool_use, tool_result) and assert that no tool_result text appears in the output.
- **Idempotent:** running capture twice inserts 0 rows the second time.
- **Retire the old paths:** `scripts/ingest-claude-sessions.ts` and `scripts/sync-conversation-session.ts` are deleted or reduced to
  call the new path. Do not leave three ingesters.

## Explicitly forbidden

- Copying raw transcripts, tool output or `.env` content to the VPS.
- Opening Postgres to the Mac, or storing database credentials on the Mac.
- An LLM call anywhere in capture.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/lib tests/unit/scripts tests/unit/tools
node --import tsx/esm scripts/brain-capture.ts --dry-run --limit 5   # on the Mac: prints 5 records, shows no secrets
```

## Acceptance criteria

- **Dry run:** the output for 5 real sessions is in the PR body, after the founder has looked at it. The content of real sessions
  is his; ask before pasting.
- **First real run:** the summary line (`ingested n, skipped m, archived k, dropped-for-secrets j`) and the matching SQL count by
  `metadata->>'origin'`.
- **Group privacy:** a unit test shows a `visibility: founder` row is absent when `thread_id` is the family group.
- **`/where`:** the output shows the capture line.
- **Live path (one probe, paid):** in the founder DM, "what did Claude do on the Mac today?" cites a dated `mac-claude` session.
  If not run: NOT VERIFIED with the reason.
