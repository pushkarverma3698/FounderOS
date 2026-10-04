# 2026-10-04 — Claude login: which account did I sign in?

## What we did
Read the prod logs for a `/login claude` run where the founder pasted a code from a different account and the reply named pushkarai3698@gmail.com. Reproduced the identity lookup on the VPS from a /tmp copy of the new code.

## What we fixed
- `/login claude [email]` puts `login_hint` on the authorize URL and says to open it in a private tab.
- The post-login reply and the `/login` status row say whether the token's account is the same as or different from the server's saved login, with that login's email. One Anthropic lookup per login.

## Why
The login had worked. The token's org (`1c2fa9ef…`) differs from the host login's (`942d106e…`). The setup-token carries no email, and `claude auth status` without the token env reports the host login, so the executor's answer looked like a failed switch. Evidence: `readHostLogin` returned pushkarai3698/`942d106e`, `lookupOrgId` returned `1c2fa9ef`, and `describeAccount` printed "a different account from this server's saved login".

## Metrics
`pnpm vitest run tests/unit/gateway/login`: 7 files, 86 passed, 1 skipped. `pnpm lint` exit 0. `pnpm verify:arch` green. `pnpm gate` fails in 13 `tests/unit/scripts/*` files (82 tests); the same 13 files fail on `origin/main` ec8858db (87 tests), so it is not this change.

## Verified afterwards (same day)
- `login_hint` with a signed-in claude.ai session: Safari was signed in as a third, free account. The authorize link carrying `login_hint=pushkar@oplify.in` ignored the hint and showed that account's "Max or Pro is required" page. The hint only helps when the browser is signed out, so the private-tab instruction is required, not a courtesy. Nothing was authorized.
- Executor mechanism, traced on the VPS: with `CLAUDE_CODE_OAUTH_TOKEN` set, `claude auth status` reports `authMethod: oauth_token` and no email. Inside `claude -p` run with that token, the Bash tool's subprocess saw an empty `CLAUDE_CODE_OAUTH_TOKEN` (`printenv … | wc -c` printed 0) and its `claude auth status` answered from the host login (pushkarai3698, `942d106e…`). That is why the executor named the old account.
- Host login unchanged: still pushkarai3698, org `942d106e…`, pro. The prod token files kept their 13:37:04 mtime through every probe.

## Outstanding
- The Telegram paste-back with a real approved code needs the founder: the OAuth consent is theirs, and the founder's account sign-in cannot be done for them.
- Decision for the founder: `claude auth logout` on the VPS host so the old login stops answering. Not run.
