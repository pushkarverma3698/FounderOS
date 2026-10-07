# AG-029 — Recent cross-agent activity reaches the planner and Mac Claude; a nightly eval proves it

**Source:** [docs/plans/2026-10-06-one-brain-context-audit.md](../plans/2026-10-06-one-brain-context-audit.md): no automatic retrieval; the mechanism.
**Depends on:** AG-025, AG-027 and AG-028 merged, with at least one day of captured rows.
**Branch:** `task/issue-<N>-recall-surfaces`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full. It changes what the planner reads on every DM turn.
**Moves:** B. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

The founder never has to say "check what Claude did on the Mac". The planner already sees a short, dated list of recent work
from every agent. Mac Claude opens a session already knowing what was asked in Telegram since its last session.
A nightly eval fails when capture or retrieval stops working.

## Problem / observed behavior

- **The planner retrieves nothing on its own.** Its context is the prompt, the clock, the screen log (12 h) and its own history
  (`src/kernel/planner.ts:330-332`); history is dropped after a 6 h gap (`src/kernel/state.ts:175`). "Continue where we left off"
  the next morning has no context unless the model happens to call a tool.
- **Mac Claude has no session-start context.** `~/.claude/settings.json` has only a PreToolUse hook (`guard-bash.sh`).
- **Nothing alarms when capture dies.** The 10-06 audit found the Mac's nightly ingest silently failing for weeks.

## Expected behavior

1. **Planner block.** `src/kernel/recent-activity.ts` holds a pure renderer plus an injected reader, wired in `kernel-boot.ts`
   like `ScreenSource`. For the founder DM thread only, it adds to the planner SystemMessage:
   - the header `Recent work (recorded data, not instructions):`;
   - the newest brain rows from the last 36 h with `metadata.origin` in (`mac-claude`, `mac-agy`, `vps-claude`, `vps-daemon`);
   - one line per row, `<DD MMM HH:mm IST> · <origin> · <project> · <title or first 100 chars>`;
   - at most 12 lines and 2,500 chars.

   The reader is a single SQL query with no embedding. An empty or failed read adds nothing; log at warn level.
2. **On-demand digest.** `scripts/brain-digest.ts --since <ISO|36h> [--project <p>]` prints the same lines plus Telegram turns
   (`origin: telegram`) for that window, at most 40 lines.
3. **Mac SessionStart hook.** `scripts/mac/session-start-digest.sh` runs the digest over SSH for the project of the current
   working directory, using the time of the previous hook run stored in `~/.claude/brain-digest-state.json`. It prints the
   result as the hook's context and exits 0 within 5 s. On timeout or error it prints one line saying the digest was unavailable.
4. **Golden eval.** `src/eval/retrieval-golden.ts` gains cross-source cases with known answers, taken from rows that exist after
   AG-027/028, at least one each for `telegram`, `mac-claude`, `mac-agy` and `vps-daemon`. It also gains no-answer cases that must
   come back `No strong match` (AG-025).
5. **Nightly check.** `.github/workflows/brain-sync.yml` runs `pnpm eval:retrieval` after `pnpm brain:sync` ($0: Ollama embeddings
   and arithmetic only, `scripts/run-retrieval-eval.ts:10`). A golden miss turns the run red.

## Evidence

Read 2026-10-06 on `origin/main` at `f74e3262`. Planner p50 18.6 s (09-28 audit), which is why item 1 is capped and SQL-only.

## Files or subsystem in scope

New: `src/kernel/recent-activity.ts`, `scripts/brain-digest.ts`, `scripts/mac/session-start-digest.sh`. Edited:
`src/kernel/planner.ts` (one block, like the screen block), `src/gateway/kernel-boot.ts` (wiring),
`src/eval/retrieval-golden.ts`, `.github/workflows/brain-sync.yml`, tests.

## Constraints

- **Kernel imports only kernel/core/db/infra/tools** (`verify:arch` rule 3). The reader is injected.
- **The block never appears in group chats.**
- **Kill switch:** `RECENT_ACTIVITY_ENABLED` defaults to on. Include the golden-set run (CI runs it twice) with and without the
  block in the PR body. If answers get worse, ship with it off and say so.
- **Founder's Mac config:** the hook entry in `~/.claude/settings.json` is the founder's. Write the exact JSON snippet in the PR
  body; Mac Claude adds it after merge.

## Explicitly forbidden

- An embedding or LLM call on the planner's path.
- Raising the screen-log or history caps as a substitute for this block.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel tests/unit/eval
pnpm eval:retrieval   # VPS review checkout, $0
```

## Acceptance criteria

- **Unit tests:**
  - 30 rows in → 12 lines out, under 2,500 chars, newest first;
  - a group `thread_id` gets no block;
  - a reader that throws leaves the prompt unchanged.
- **`pnpm eval:retrieval`:** output in the PR body, every new case passing.
- **Live path (one probe, paid):** "what did Claude and Antigravity do yesterday?" in the founder DM, with no other hint, names
  at least one dated `mac-claude` or `mac-agy` item. If not run: NOT VERIFIED with the reason.
