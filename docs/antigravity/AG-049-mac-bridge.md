# AG-049 — Mac bridge: FounderOS can read and act on the founder's Mac

**Source:** [docs/plans/2026-10-08-root-fix-task-list.md](../plans/2026-10-08-root-fix-task-list.md) task 15.
**Depends on:** founder decision 3 in that plan (install an agent on the Mac).
**Branch:** `task/issue-<N>-mac-bridge`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: a new channel that acts on the founder's machine, plus a shared secret.
**Moves:** A. Needs the `unfreeze` label and the founder's yes on decision 3.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

From Telegram: "send me the PDF in ~/Downloads I got yesterday", "what is open on my screen", "run pnpm test in
~/Projects/founderos". Today the bot only reaches the VPS, so every one of these needs the laptop.

## Problem / observed behavior

- The `personal` department tools (`src/agents/capabilities.ts:127-172`: readFile, listDir, runShell, browser) run on the
  VPS. Nothing reaches the Mac except the screen log (`src/infra/screen-log.ts`, AG-027), which only pushes summaries.

## Expected behavior

1. A small Node agent on the Mac, run by launchd. It long-polls the VPS hub over HTTPS (outbound only, no open port on
   the Mac) and authenticates with a token kept in the macOS keychain.
2. Four tools for the `personal` worker:
   - `mac_read_file` (path → text or a Telegram attachment, under `~/Projects`, `~/Documents` and `~/Downloads` only);
   - `mac_list_dir`;
   - `mac_screenshot` (sent as a Telegram photo);
   - `mac_run` (command + cwd). Gated by `hitlGate()` inline, with the exact command on the card.
3. If the Mac is asleep or offline, the tool fails within 10 s with "Your Mac is offline", never a timeout.
4. Every call writes an `action_log` row.

## Constraints

- Read tools do not need approval. `mac_run` always does, including read-only-looking commands.
- No path outside the three folders, with symlinks resolved before the check.
- The token is rotated by a script, not hard-coded. Document the install in `scripts/mac-bridge/README.md`.

## Explicitly forbidden

- Inbound connections to the Mac.
- Reading `~/Library`, keychains, browser profiles or `.env*` files.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/tools tests/unit/agents
```

## Acceptance criteria

- Unit tests: path allowlist (including a symlink escape), offline timeout, `mac_run` calls `hitlGate()` before any spawn.
- Real path: from Telegram, "list ~/Downloads", "screenshot my Mac", and `mac_run` of `git -C ~/Projects/founderos status`
  after approval. Each produces the reply and an `action_log` row.
