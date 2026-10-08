# AG-053 — One tool registry for the bot and the hub

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-053.
**Depends on:** draft PR #1007 (AG-042). Start from its branch, or rebase it onto beta and finish it here.
**Branch:** `task/issue-<N>-one-tool-registry`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: cross-client contract, exposes prod reads to MCP clients.
**Moves:** A. Needs the `unfreeze` label (`src/mcp/` is frozen).

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

One flat list of tools, built once, used by both the bot and the VPS hub. Departments no longer decide which tools a
model can see. Calendar reads, which the hub has and the bot lacks, reach the bot.

## Problem (measured)

- The bot's tools are split into 8 departments in `src/agents/capabilities.ts:126-137`, with 3 more sub-role maps
  below them. A question that needs GitHub (engineering) and past chats (admin) depends on the planner picking both
  departments before it has read anything.
- The VPS hub (`src/mcp/hub-server.ts`, `hub-google.ts`, `brain-tools.ts`) has its own tool set: search_memory,
  get_memory, remember, save_decision, save_bug, gmail_search, calendar_events, and bridged servers. `calendar_events`
  has no bot counterpart. The bot's `readEmails` and the hub's `gmail_search` are two implementations of one read.
- Some tools appear in several departments (`searchKnowledge` is in 5, `searchWeb` in 3, `readLogs` in 2).

## Expected behavior

1. **`src/agents/registry.ts`** exports `ALL_TOOLS`: each tool once, tagged `read` or `write`, where `write` means the
   tool calls `hitlGate()`. Departments become a view over this list, built from it and kept only until AG-057 deletes
   them. The current kernel keeps working unchanged.
2. **Hub serves the registry.** Scope `all` = the registry's `read` tools + brain tools + bridged servers, under their
   own names. Use a `fos_` prefix only where a name collides with a bridged tool. AG-042's safety test carries over:
   no `write` tool is ever served by the hub.
3. **One implementation per read.** Gmail and calendar reads use one module, shared by the hub and the bot (the
   per-account gws cache from #1031). Delete the second copy.
4. **Drift test.** A CI test builds both lists and fails if a `read` tool is in the registry but not in the hub, or the
   other way round, unless it is on a short, commented exclusion list (for example `vps_run`).
5. **Size check.** Print the token size of all tool schemas together. AG-054 binds every tool to one model, so the
   number has to be known. If it is over 20K tokens, list the 10 largest schemas in the PR.

## Files in scope

`src/agents/registry.ts` (new), `src/agents/capabilities.ts`, `src/agents/agent-tools/`, `src/mcp/hub-server.ts`,
`src/mcp/hub-google.ts`, `src/mcp/brain-tools.ts`, the Gmail and calendar read modules, `tests/unit/mcp/`,
`tests/unit/agents/`.

## Constraints

- No write path through the hub. Writes stay in Telegram with an approval card.
- No new server, port or transport.
- 400-line cap per file (`verify:arch`).
- The current kernel's behavior must not change: `tests/unit/kernel/kernel-e2e.test.ts` passes unchanged.

## Explicitly forbidden

- A third tool list, or any copy of tool schemas.
- Serving any tool that returns tokens or secrets.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/mcp tests/unit/agents tests/unit/kernel
```

## Acceptance criteria

- A failing drift test first (it fails today, because `calendar_events` is in the hub only), then green.
- After deploy, from the Mac, `turicks-brain` lists the registry's read tools, and one call to `fos_github_read`
  list_prs (or its final name) returns the same PR numbers as `gh pr list`.
- In Telegram, "what's on my calendar today?" reaches the shared calendar read. Paste the reply and the `action_log`
  row.
