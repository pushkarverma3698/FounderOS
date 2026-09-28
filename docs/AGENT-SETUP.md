# How the agent setup works

Written 2026-09-28, after the unified-setup work (#746, #747, #749, #751). Where this and the code
disagree, the code wins. Check the live state anytime with `~/Projects/scripts/ai-tools/verify-agent-setup`
on the laptop, which runs 36 PASS/FAIL checks and spends nothing.

## The short version

1. **One rulebook.** `~/.agents/AGENTS.md` on the laptop is the only copy. Every coding agent reads it,
   on the laptop and on the VPS.
2. **One memory.** The brain is Postgres on `founderos-vps`. Every agent reaches it through the hub.
3. **One hub.** `src/mcp/hub.ts` is a single MCP server. It gives any agent the brain, Gmail and Calendar
   reads, and every MCP server connected on the VPS. It reads freely and refuses writes.
4. **One loop.** A builder opens a draft PR to `beta`. Claude on the VPS reviews it. Cleared FounderOS
   work is merged into `beta`, then promoted to `main`, which deploys.
5. **Claude runs only on demand.** Nothing on the VPS starts a Claude session unless a PR is waiting
   for review, and nothing starts Antigravity unless an issue is labelled `agent:ready`.

## The pieces

| Piece | Where | What starts it | Spends tokens when |
|---|---|---|---|
| Claude Code, Codex, Cursor, Gemini CLI, Antigravity | laptop | you | you use them |
| FounderOS bot (Telegram, the kernel) | VPS, `founderos.service` | always on | a message or a scheduled job runs a model turn (daily cap: `/budget`) |
| `pr-brain`: Claude reviews PRs | VPS cron, every 20 min | a PR whose head changed since its last review | once per new PR head, Sonnet, $5 cap |
| `agent-dispatch`: Antigravity builds | VPS cron, every 15 min | a GitHub issue labelled `agent:ready` | once per claimed issue (max 1 per repo per tick) |
| The hub | VPS, started by each tool over SSH | a tool opening its MCP connection | never on its own |
| Brain docs sync | GitHub Actions, 03:17 UTC daily | schedule or `gh workflow run brain-sync.yml` | never (local Ollama embeddings) |
| Watchdog | VPS cron, every 2 min | schedule | never (a health curl) |

An idle day costs zero Claude sessions. `pr-brain` and `agent-dispatch` still wake up, but an idle tick
makes GitHub API calls only.

## Rules

- **Source:** `~/.agents/AGENTS.md`, plus the `production-ready` and `pr-adversary` skills in
  `~/.claude/skills/`.
- **Laptop:** `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` and `~/.gemini/antigravity/GEMINI.md` are
  symlinks to it. `~/.claude/CLAUDE.md` imports it.
- **VPS:** after editing any rule or skill, run `~/Projects/scripts/ai-tools/sync-agent-rules`. It copies
  them to `/opt/agent-rules` on the VPS. There:
  - Claude (the `founderos` user) reads `CLAUDE.vps.md`, which is the rulebook plus VPS notes.
  - Antigravity (the `antigravity` user) reads `AGENTS.md`.
  - `sync-agent-rules --check` only compares.
- **Repo rules win** for their repo: CLAUDE.md, AGENTS.md, CI.
- **Oplify:**
  - Oplify's rules live only in `~/Oplify.in/CLAUDE.md`. The repos see them through git-excluded symlinks.
    They are never committed.
  - Oplify `main` is production: PR only, and a human merges.

## Memory: the brain

- **Tools:** `search_memory`, `get_memory`, `save_decision`, `save_bug`, `remember`. Always pass the
  project tag (`founderos`, `oplify`, `linkedin-growth-engine`, `turicks`, `campaignos`, or the repo folder name).
- **What `search_memory` searches:**
  - saved notes, decisions and bugs;
  - every doc under FounderOS `docs/`, which the daily brain sync indexes from the code production runs.
- **How each agent reaches it:**
  - **Laptop tools:** `~/Projects/scripts/ai-tools/founderos-brain-mcp.sh` SSHes to the VPS and starts
    `hub.ts`. Every tool's MCP config points at this one launcher.
  - **Claude on the VPS:** starts `hub.ts` directly.
  - **Antigravity on the VPS:** runs `/opt/agent-rules/brain-mcp.mjs`, a brain-only bundle. It connects as
    the Postgres role `brain_agent`, which can reach only `brain.brain_memories`. It cannot read FounderOS
    code, its `.env`, or any other table. `sync-agent-rules` rebuilds the bundle, so run it after a deploy
    that changes brain code.
- **Never save** secrets, keys, customer data or personal data (UPI ids, phones, emails).

## The hub

**What it gives an agent** (9 tools):
- the 5 brain tools;
- `gmail_search` and `calendar_events`, across every connected Google account;
- `list_connected_tools` and `call_connected_tool`, for every server in `/opt/founderos/mcp-bridge.json`
  (today `deepwiki` and `slack`).

**Reads only.** A tool the bridge classifies as a write is refused before the hub connects to it. Anything
that sends or changes something goes through the Telegram bot, which asks you to approve it first.

**To connect a new MCP server for every agent:** add it to `/opt/founderos/mcp-bridge.json` on the VPS. The
hub re-reads that file on every call, so it needs no restart and no change on the laptop.

**Google:** reads need a live OAuth grant per account. On 2026-09-28 all grants were dead
(`invalid_grant`), so the hub answers "needs re-authorization" until the app is published and each
account signs in again.

## How work flows

1. **Work starts in one of three ways:**
   - a laptop session;
   - `/task` in Telegram, which leads to an approval card;
   - a GitHub issue labelled `agent:ready`.
2. **A builder writes it on a branch and opens a draft PR** to `beta`:
   - Antigravity through `agent-dispatch`;
   - Claude through Telegram `claude_code`;
   - or you, with any laptop tool.
3. **`pr-brain` reviews it** with the `pr-adversary` skill in `/opt/review/<repo>`. It never touches
   `/opt/founderos`. It then does one of three things:
   - **clears it:** marks the PR ready. FounderOS PRs are merged into `beta`, and a `beta` → `main`
     promotion PR is opened.
   - **pushes a fix**;
   - **requests changes.**

   It reviews each PR head once. A new push, or a `beta` merge into the branch, triggers a new review.
4. **Promotion to `main`** is merged by you, or by Claude when CI is green (FounderOS rule only). CI on
   `main` triggers Deploy, which updates `/opt/founderos` and restarts `founderos.service`. Health:
   `curl 127.0.0.1:3001/health` on the VPS.
5. **After a deploy,** smoke-test the change once through its real entry point.

**Guardrail on Telegram `claude_code`:**
- On FounderOS, Oplify and House of Hulda, a git hook refuses pushes to `main`, `master`, `beta` and
  `development`, and `gh pr merge` is refused.
- It works in `~/Projects/agent-workspace`, pushes a feature branch, and opens a draft PR to `beta`.

## Telegram

- **Your own chat** (`TELEGRAM_CHAT_ID`): everything works, as before.
- **Any group you add the bot to:**
  - It answers you when you @mention it, reply to it, or send a command.
  - It ignores the rest of the conversation.
  - Everyone else in the group is ignored.
- **Opening a group to everyone:** add its id to `TELEGRAM_ALLOWED_CHAT_IDS` in the VPS `.env` and restart.
  - Before you do: everyone in that group can then use every tool that needs no approval. That includes
    reading your email, files and memory, and cancelling or moving your scheduled posts and tasks.
  - Approvals and `/halt /resume /task /newproject /connect` stay yours.
  - The bot tells you this the first time you talk to it in a new group.

## Switches and checks

| Want to | Do |
|---|---|
| Stop PR reviews | `touch ~/.claude/pr-brain.off` on the VPS (delete to resume) |
| Stop Antigravity dispatch | `touch ~/.claude/agent-dispatch.off` on the VPS |
| Stop every bot turn | `/halt` in Telegram (`/resume` to undo) |
| Check the whole setup | `verify-agent-setup` on the laptop |
| Push rule or skill edits to the VPS | `sync-agent-rules` on the laptop |
| See today's spend | `/budget` in Telegram |

## Open items on 2026-09-28

1. **Google:** publish the OAuth app (Google Cloud → Google Auth Platform → Audience), then sign in each account on the VPS.
2. **Composio:** revoke the API key in its dashboard. It sat in plaintext configs.
3. **GitHub:** replace the VPS `GITHUB_TOKEN`, a classic token with delete-repo scope, with a fine-grained one.
4. **Telegram groups:** send one @mention in a group to prove the group fix live.
5. **Known cost:** a cleared PR whose branch is behind `beta` gets a full second review after `pr-brain`
   merges `beta` into it.
