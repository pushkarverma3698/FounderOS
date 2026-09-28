# 2026-09-28 — One setup for every agent: rules, brain, hub, and on-demand Claude

## What we did
- **One rulebook on the VPS.** `~/Projects/scripts/ai-tools/sync-agent-rules` (laptop) copies
  `~/.agents/AGENTS.md`, the `production-ready` and `pr-adversary` skills and the local Oplify rules
  to `/opt/agent-rules`. The VPS Claude (`founderos` user: pr-brain gates, Telegram `claude_code`) and
  the VPS Antigravity (`antigravity` user) read it through symlinks. The old 17KB VPS CLAUDE.md, 205
  agent files, ~80 commands and 8 unused skills moved to `~/.claude/backups/setup-audit-2026-09-28`.
- **The brain for the VPS agents.** VPS Claude: user-scope MCP. VPS Antigravity: a `brain_agent`
  Postgres role (read/write `brain.brain_memories` only, 1 of 39 tables) and a bundled brain-only
  server at `/opt/agent-rules/brain-mcp.mjs`, because it cannot run code from `/opt/founderos`
  (deploy writes it under umask 077) and must not read its `.env`.
- **#746 pr-brain calls Claude on demand only**, and gives Claude an empty stdin inside the PR loop.
- **#747 `claude_code` can't land code on the product repos without a PR**: pre-push hook + gh wrapper.
- **#749 the hub** (`src/mcp/hub.ts`): brain, Gmail/Calendar reads per account, and every server in
  `mcp-bridge.json` through two tools, for every coding tool. Writes stay in Telegram. `.mcp.json`
  (a second server on the laptop's own database) removed.
- **One Ollama.** The host `ollama.service` (crash-looping since July) is disabled; the
  `founderos-ollama` container serves embeddings. After its failed start, `docker start` kept an
  endpoint with no host port; `docker compose -f deploy/stack.compose.yml up -d --force-recreate
  ollama` fixed it.
- **Stale config removed**: OmniRoute (LaunchAgent, MCP entry, 10 skills, `.env` lines), Composio
  (API key in 4 MCP configs and 2 shell rc files), the dead nightly QA cron on the VPS.

## What we fixed
| Before | After | Found by |
|---|---|---|
| 72 Claude sessions/day from pr-brain's preflight, each ~50k tokens | 0 when no PR waits | founder's token audit |
| pr-brain gated at most one PR per repo per tick (`claude -p` read the loop's stdin) | all waiting PRs, up to the cap | stage-5 self-review |
| VPS Claude sessions started at 47-50k tokens | 26,016 tokens | measuring VPS transcripts |
| `claude_code` could push to Oplify `main` (no branch protection on the free plan) | refused; draft PR instead | Telegram setup audit + security review |
| VPS agents ran a stale rulebook with no brain | same rules as the laptop, brain connected | Telegram setup audit |
| Deploys failed at "Ensuring Postgres + Ollama are up" (12:08 and 12:35 runs): a second, host-level `ollama.service` held 127.0.0.1:11434 | host service disabled; the container owns the port | reading the failed deploy log |

## Why
One set of rules, one memory and one review gate for every agent, whether work starts from Telegram
or the laptop; Claude spent only when there is work.

## Metrics
- pr-brain: 72 → 0 idle sessions/day. VPS session start: ~50k → 26k tokens.
- Tests added: pr-brain 5 (16 total), git guard 55 (with claude_code), hub 27. Mutation probes:
  8/8, 24/24, 15/15 killed. Independent gates: security-reviewer on #747 (3 findings fixed),
  pr-brain on #747 and #749 (PASS; `pnpm gate` 4797/4797 on #749).
- Hub QA on the VPS (`scripts/qa-hub.ts`): 11/11 scenarios against the real brain, Google and DeepWiki.

## Outstanding
1. Google: all three grants are dead (`invalid_grant`); publish the OAuth app and sign in per account.
2. Revoke the Composio API key (it sat in plain text in tool configs).
3. Replace the VPS `GITHUB_TOKEN` (classic, `admin:org` + `delete_repo`) with a fine-grained token.
