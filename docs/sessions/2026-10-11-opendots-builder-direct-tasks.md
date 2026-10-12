# 2026-10-11 — OpenDots: the Builder takes direct tasks with claude or agy (AG-064)

Branch `feat/builder-engine-chat`, PR #1124 (base `claude/chore-opendots-migration`). Deployed to `/opt/opendots`.

## What we did
- `team-shift builder --engine claude|agy --task '...' [--repo]` files an issue and starts the chosen engine. `--progress` gives ≤5 lines. Every run ends with WHAT I DID / WHY / WHAT'S LEFT / RESULT.
- Live on the sandbox: claude → PR #20; agy → PR #23 (4 min). The Chief's "status across all my repos" took 1 model call.

## What we fixed (audit of the Chief and Builder chats)
1. The Chief's `timeoutMs 70000` broke the 60000 schema cap, so every dispatch failed. The fix is 60000.
2. The Builder said "the Chief handles login/dispatch". The prompt now runs `dot-login status` and dispatches itself.
3. Team repos went from the sandbox only to the four repos the token can push to.
4. A finished run made the Builder answer "Busy" for up to 15 min. `--task` now closes the finished run first.
5. agy ends its whole run on any command outside the allowlist (a `rm` of a leftover file). Runs now start from a clean checkout of the base branch, and the prompt lists the allowed commands.

## Why
The founder could not dispatch through either Dot. Causes 1, 2 and 4 each blocked dispatch on their own.

## Metrics
- Builder dispatch turn: 1 model call, 1 tool call. Chief status: 1 model call, 23 s.
- agy sandbox task: 4 min to a draft PR.

## Outstanding
- OplifyMessage/* and turickai/*: the computers' fine-grained PAT gets 404. A token covering them is needed.
- The Architect computer has no agy login.
- agy shows no live steps, only its ending.
