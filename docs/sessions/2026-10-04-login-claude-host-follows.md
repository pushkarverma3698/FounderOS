# 2026-10-04 — /login claude, step 2: the server's own login follows the token

## What we did
Read the prod logs after #864 shipped (deployed 15:19 UTC). The founder ran `/login claude <email>` at 15:22 and said the problem persisted. It had not failed. Both token files (mtime 15:22:43) hold a token in org `1c2fa9ef…`, the founder's chosen account. The reply named the only email the bot knows, which belongs to the stale host login (`942d106e…`), so it read as "still the old account".

## What we fixed
- When the token's org differs from the server's own saved login (or there is none), `/login claude` now sends a second link right away. It is `claude auth login --claudeai [--email]`, run in a scratch HOME. The link opens in the same private tab, so it takes one Authorize tap and one paste.
- After the paste, the scratch login must be in the token's org. Only then are two keys copied into the real files: `claudeAiOauth` into `~/.claude/.credentials.json` and `oauthAccount` into `~/.claude.json`. Plugin MCP logins and settings stay. Old files are kept as `*.before-login`. `claude auth status` must then report the new email and org, or both files are restored.
- Login contract: `LoginFinished.next` hands the pending attempt to a follow-up step.
- `/login agy`: a missing agy binary now says "agy is not installed for the bot's user" instead of "no menu appeared".

## Why this design
A `setup-token` token has scope `user:inference` only. The profile and account endpoints return 403 for it, so the token can never name its email. Only a full `claude auth login` carries `user:profile`. The founder chose "second tap, server follows" over a hidden one-tap swap.

## Not verified
- The success path of `claude auth login` (prints "Login successful.", exits 0, leaves `.claude/.credentials.json` + `.claude.json` in the scratch HOME). This comes from the binary's strings and the layout of the host's own files. The founder's real two-tap run will prove it.
- A concurrent `claude` process that rewrites `~/.claude.json` just after the install could put back the old `oauthAccount`. The post-install check catches it only if it happens before the check runs.
