# AG-035 — Investigation depth: read-only steps get room to find the answer

> Superseded in part (2026-10-08): the caps are now 20 (read) and 10 (write), set by code from the step class; the planner's `max_tool_calls` is ignored and read-only tool narrowing was removed. The 15 and 6 below are the original design. See `src/kernel/step-budget.ts`.

**Source:** [docs/plans/2026-10-07-understanding-plan.md](../plans/2026-10-07-understanding-plan.md) task 6.
**Depends on:** nothing.
**Branch:** `task/issue-<N>-investigation-depth`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: it changes a kernel contract limit and adds a code-reading tool.
**Moves:** A. Needs the `unfreeze` label.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

Claude Code answers "why does /jobs show stale jobs?" by reading the handler. FounderOS gives up after 6 calls or guesses a
path. A read-only investigation step gets enough calls and a tool that reads code, so it finds out instead of guessing.

## Problem / observed behavior

- `MAX_TOOL_CALLS_PER_STEP = 6` (`contracts.ts:176`) caps every step, read-only or not.
- 09-06 #300: "tool limits were reached before inspecting the handler".
- 10-06 #561: the cleanup step hit the cap.
- 09-07 #321: looked for the sweep code at a path that does not exist; the founder had to say "fetch from turicks brain".
- `github_read` (`agent-tools/engineering.ts:197`) lists repos, issues, PRs, commits and READMEs. It cannot read a file or
  search code, so engineering cannot read its own source.

## Expected behavior

1. **Two caps.** `MAX_TOOL_CALLS_PER_STEP` stays 6 for steps with `hitl_required: true` or any side-effecting tool. A new
   `MAX_READ_TOOL_CALLS_PER_STEP = 15` applies when every tool the worker binds for the step is read-only.
   - The read-only set is derived from code: a tool is read-only when it is not in `HITL_GATED_TOOLS` and does not call
     `hitlGate()`. A unit test fails if a tool calls `hitlGate()` and is still classed read-only.
   - The envelope `constraints.max_tool_calls` max becomes 15; dispatch clamps to 6 when the step is not read-only.
2. **`github_read` gains two actions:**
   - `get_file` (owner, repo, path, optional ref → content, max 400 lines with a "truncated" marker);
   - `search_code` (owner, repo, query → up to 20 `path:line` hits), through the GitHub API.
   Default owner/repo stays FounderOS.
3. **Cap messages are explicit.** When a step hits its cap, the StepResult says which question was left unanswered.
   The synthesizer shows that line to the founder rather than a guess (#26: every reason printed with its result).

## Files or subsystem in scope

`src/kernel/contracts.ts` (constant and envelope max; 386 lines, so put helpers elsewhere), `src/kernel/supervisor.ts`
(clamp), `src/agents/agent-tools/engineering.ts`, the GitHub tool implementation in `src/tools/`, tests.

## Constraints

- No change to HITL behaviour: write tools still gate inline.
- The GitHub token is read-only for these actions; no new scopes.
- Watch latency: report the p50/p90 of the AG-030 depth case before and after.

## Explicitly forbidden

- Raising the cap for steps that can write.
- Shell or filesystem access on the VPS for this (GitHub API only).

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/kernel tests/unit/tools
pnpm eval --suite understanding    # one paid run; case #300
```

## Acceptance criteria

- Unit tests:
  - the clamp (read-only step 15, gated step 6);
  - the read-only classification test that fails if a gated tool slips in;
  - `get_file` truncation and `search_code` parsing, with the GitHub client stubbed.
- AG-030 case #300 passes on the live run.
- Real path: in Telegram ask "why does /jobs show stale jobs?". The reply cites a file and line it read. Trace line in the
  PR body.
