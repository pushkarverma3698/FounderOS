# AG-024 — History says "Offered", not "Ran"; list tools say when they cut a list

**Source:** [docs/plans/2026-10-06-one-brain-context-audit.md](../plans/2026-10-06-one-brain-context-audit.md), H1 and H4.
**Branch:** `task/issue-<N>-honest-command-history`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full. It changes what the planner believes it did on every planned command.
**Moves:** B. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) before writing code.

## Goal

The conversation history never claims a command ran when the founder was only shown a "Run this?" card.
A list a tool cut short says so, so the reply doesn't present 20 rows as "all".

## Problem / observed behavior

- `src/kernel/planner.ts:384-392`: every planned command sets `reply: "Ran /<name> <args>"` before the gateway
  decides anything.
- `src/gateway/command-dispatch.ts:88-104`: when `needsConfirmation(name, args)` is true
  (`src/gateway/command-catalog.ts:30-33`), the gateway only shows "Run this?" with ✅ Run / ✖ Cancel and holds the
  command in an in-memory map.
- Prod, 2026-10-06 02:36 and 02:58: "my goal this month is 20 applications" was recorded twice as
  "Ran /goal add 20 applications …". `agents.goals` has 0 rows. Later, "What are the latest goals?" answered
  "No goals yet".
- `src/tools/github.ts:301-304`: `list_commits` fetches `per_page: 20` with no `since`. Prod 10-06 11:50: "what was
  done in FounderOS in the last 2 days" → "20 commits total, all from Oct 6". `origin/main` has 80 commits dated
  10-05 IST.

## Expected behavior

1. `CommandCatalogEntry` (`src/kernel/planner.ts:54`) gains `writesWithArgs: boolean`, filled in
   `plannableCommands()` from the same `WRITES_WITH_ARGS` set. The planner decides with one pure function
   `commandNeedsTap(entry, args)` that returns `entry.mutating || (entry.writesWithArgs && args.trim() !== "")`.
2. When it returns true, the history reply reads `Offered /<name> <args>: not run until the founder taps ✅ Run`.
   Otherwise it keeps `Ran /<name> <args>`.
3. A unit test walks every entry of `plannableCommands()` with empty and non-empty args and asserts
   `commandNeedsTap` equals `needsConfirmation`. The two can't drift apart silently.
4. `list_commits` accepts an optional `since` (ISO date) and passes it to Octokit. Both the UnifiedTool schema and
   the LangChain wrapper schema (`githubRead`, `src/agents/agent-tools/engineering.ts:168`) carry it. The wrapper has dropped fields before, so test it.
5. When a list tool returns exactly `per_page` rows (`list_commits`, `list_prs`, `list_issues`, `list_branches`),
   its result carries `truncated: true` and the text line `Showing the first <n>; more exist. Narrow with since/state.`

## Evidence

Read 2026-10-06 on `origin/main` at `f74e3262`. Turn rows: `agents.conversation_turns`, 2026-10-06 02:36:41 and 02:58:25 UTC.

## Files or subsystem in scope

`src/kernel/planner.ts` (command branch and `CommandCatalogEntry` only), `src/gateway/command-catalog.ts`,
`src/tools/github.ts`, the GitHub agent-tool wrapper, tests under `tests/unit/kernel/`, `tests/unit/gateway/`,
`tests/unit/tools/`.

## Constraints

- Kernel must not import gateway (`verify:arch` rule 3). The predicate's data comes in through the catalog, as `mutating` does today.
- `src/kernel/planner.ts` stays under 400 lines. Put `commandNeedsTap` in a small kernel file if needed.
- The pending-command map and its TTL stay as they are.

## Explicitly forbidden

- Making `/goal add` (or any command) skip confirmation to "fix" the history.
- Changing which commands need confirmation.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel tests/unit/gateway tests/unit/tools
```

## Acceptance criteria

- Scripted-model kernel test: a planned `/goal add …` leaves history reply `Offered /goal add …`; a planned `/where` leaves `Ran /where`.
- Parity test from Expected 3 passes for every catalog entry.
- Tool test: 20 mocked commits → result text contains `Showing the first 20; more exist`.
- Live path (one probe, paid): "my goal this month is 3 test applications" in Telegram, then "what did I just ask
  you to do?". The reply says it was offered, not done. Cancel the card. If not run: NOT VERIFIED with the reason.
