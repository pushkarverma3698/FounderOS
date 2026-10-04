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
- Calendar event creation has no account choice yet (always department routing → turicks).
- Added accounts work on the `gws` backend only; `googleapis`/`composio` still route through the registry.

## More Google accounts (2026-10-04, founder: "Telegram needs to be our workspace")
`/login google add <name>` signs any Google account in under a name he picks (his, a second business, or someone who forwards him the link back). `/login google remove <name>` deletes it. An added account is only its folder `~/.founderos/accounts/<name>/gws/credentials.json` (`src/infra/google-mailboxes.ts`): no DB row, no deploy. Built-in accounts stay as they are and cannot be removed.

Every reader takes the name: kernel `read_emails` (new `account`, incl. `all`) and `send_email` (approval card says which account sends), the MCP hub `gmail_search` / `calendar_events`. Found on the way: an unknown `account_key` silently fell through to turicks; the gws provider now refuses it and lists the valid names.

## Claude: which account did I just sign in? (2026-10-04, branch `feat/login-claude-account-hint`)
Founder pasted a code from a different Google account and the bot's reply still named pushkarai3698. The login had worked: the stored token belongs to org `1c2fa9ef…`, the server's own saved login (`~/.claude.json`) to org `942d106e…`. `claude setup-token` issues a token with scope `user:inference` only, so it carries no email; a `claude auth status` run without the token env answers from the host login, which is what the executor printed.

- `/login claude [email]` adds `login_hint=<email>` to the authorize URL and tells him to open it in a private tab (the page signs in whichever Claude account that browser already has; the bot cannot change that).
- After the paste, and in the `/login` status row, the bot compares the token's org (`anthropic-organization-id` header on a free `count_tokens` call) with the host login's org and says "same account" or "a different account from this server's saved login (email)". It never prints the token and cannot name the token's own email.
- Not changed: the host login stays. Anything run without the token (a plain `claude` over SSH) still answers as the old account until `claude auth logout` runs on the VPS host, which is the founder's call.
