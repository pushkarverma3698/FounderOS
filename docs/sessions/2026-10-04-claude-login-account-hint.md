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

## Outstanding
- NOT VERIFIED: `login_hint` when claude.ai already has a signed-in session in that browser; the Telegram paste-back with `/login claude <email>` (needs deploy).
- Decision for the founder: `claude auth logout` on the VPS host so the old login stops answering. Not run.
- Mechanism of why the executor's nested `claude auth status` lacks the token env is inferred, not traced.
