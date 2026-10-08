# AG-042 — FounderOS's own read tools in the VPS hub (one tool layer for every client)

**Source:** [docs/plans/2026-10-08-daily-driver-plan.md](../plans/2026-10-08-daily-driver-plan.md) goal 3.
**Depends on:** nothing.
**Branch:** `feat/native-tools-in-hub`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full (exposes prod data to MCP clients; cross-client contract). Follow `~/.claude/skills/production-ready/SKILL.md`.
**Moves:** A and B. Needs the `unfreeze` label (`src/mcp/` is frozen; founder approved 2026-10-08).

## Goal
Claude Code on the Mac, Antigravity on the VPS and any MCP client see the same FounderOS tools the Telegram bot uses (GitHub reads, ops state, goals, jobs, recall, …) through the existing hub, so "one tool layer" is real and there is one implementation per tool.

## What already exists (do not rebuild)
- `src/mcp/hub.ts` (stdio over SSH) and `src/mcp/hub-server.ts`: scope `all` = brain + Google reads + bridged MCP servers; scope `brain` = brain only. The Mac's `turicks-brain` MCP is this hub.
- The bot's tool registry (`src/agents/agent-tools/`, `src/agents/capabilities.ts`, `src/tools/*` UnifiedTool with the ToolResult envelope) and the read-only classification from AG-035.
- `HITL_GATED_TOOLS` (rendering declaration) and inline `hitlGate()` calls in side-effecting tools.

## Expected behavior
1. Scope `all` adds FounderOS's read-only tools, built from the same registry objects the bot binds (no second implementation, no copy of schemas). Name them so they cannot collide with bridged tools (e.g. `fos_<tool>`).
2. Only tools classified read-only are exposed. A unit test builds the hub tool list and asserts none of them is in the side-effect set (no `hitlGate()` caller, nothing in `HITL_GATED_TOOLS`, nothing that sends/writes/dispatches). Adding a write tool to the hub must fail that test.
3. Tool calls through the hub run with the hub's env (prod `.env` on the box) and return the ToolResult envelope as MCP text/JSON; errors become MCP errors with the tool's message.
4. Scope `brain` is unchanged (agents that must not read mail still get brain only).
5. Update the hub's `INSTRUCTIONS` text and `docs/` where the hub is described.

## Constraints
- Writes stay in Telegram with HITL. This brief adds no write path.
- No new server, port or transport; stdio over SSH as today.
- File size cap 400 lines per src file (`verify:arch`).

## Explicitly forbidden
- Exposing any side-effecting tool, or any tool that returns secrets/tokens.

## Verification commands
- Failing tests first (hub tool list contains `fos_ops_state`/`fos_github_read` style reads; contains no side-effecting tool).
- `pnpm lint && pnpm verify:arch && pnpm verify:doc-claims` + `pnpm vitest run tests/unit/mcp`.
- Local stdio smoke without prod secrets is fine; no VPS calls. The orchestrator verifies through the Mac's MCP client after deploy.

## Acceptance criteria
- After deploy, the Mac's hub client lists the FounderOS read tools and one call (`ops_state`) returns the deployed commit.
- PR body: What changed · How it was verified · NOT VERIFIED, `Moves: A B`, label `unfreeze`.
