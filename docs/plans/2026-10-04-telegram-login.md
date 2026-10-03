# /login — renew every credential from Telegram

**Outcome:** when a login expires (Google, Claude Code, agy, or whatever replaces them), the founder renews it from his phone in under a minute, with no SSH and no `.env` edit.

**Binding constraint:** the VPS has no browser. Each tool's own `login` opens one, so the flow has to be link-out, paste-back.

## Shape
One command, `/login`, founder's private chat only. `/login` shows ✅/❌ per credential. `/login <tool> [target]` returns a link; the next message he sends is the pasted code or URL, which is consumed and deleted, never reaches the kernel or the logs. Each tool is one file in `src/gateway/login/adapters/` implementing `LoginAdapter` (`types.ts`) plus one line in `registry.ts`.

| Adapter | Status |
|---|---|
| `google <turicks\|personal\|naggar>` | this PR: OAuth installed-app + PKCE, paste the `http://localhost/?code=` URL, writes the account's `credentials.json`, verified by a live Gmail `getProfile` |
| `claude`, `agy` | separate PR (`feat/login-claude-agy-adapters`) |

## Found on the way
gws 0.22 ignores `GWS_CONFIG_HOME`; the per-account profile dirs ADR-036 describes were never read, so every account used the host's one login (proved on the VPS 2026-10-04: a probe credentials file is honored only via `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`). `gwsEnv()` now sets that variable when the account's `credentials.json` exists, and falls back to the host login otherwise, so prod keeps working until each account is signed in.

## Open
- An account with no `credentials.json` still falls back to the host login, which can be another mailbox. Remove the fallback once all three accounts are signed in.
- If the Google OAuth app is in "Testing", refresh tokens die after 7 days; publish it ("In production") in Cloud Console.
- More Gmail accounts = one entry in `ACCOUNT_KEYS` + `ACCOUNT_SEED_SPECS` (src/core/accounts.ts).
