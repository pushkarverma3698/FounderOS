# Unblock Runbook — finish the production-grade 1.0 (2026-06-27)

This is the exact, do-this-next checklist to take FounderOS from "prod stable + deployable" to "everything green + the capability story live." Written for the founder to execute (or hand the keys to Claude and have it apply them).

## Where we are now (already done this session)
- ✅ **main is deployable again** — three layered deploy bugs fixed + merged: lockfile (#241), Postgres password self-heal (#243), MCP-grep `set -e` abort (#244).
- ✅ **Prod is current** (`86865f2`, was stuck at `186f077` for days). Service active, DB up, RAG healthy (251 vectors). DB data intact.
- ✅ **Email/calendar fix is coded** — googleapis service-account backend (PR #245). Inert until keys are set.
- ✅ **MCP "add keys & go" gallery** shipped (`docs/guides/MCP-SERVERS.md`).
- 🔴 **Still degraded:** `/health gmail_active: down` (email/calendar) — needs the Google key below. `claude_code` spend-limited. Judge key is a placeholder. Apify token missing.

---

## Part A — Restore email + calendar (the #1 fix)

### A1. Create the Google service account (Google Cloud Console — console.cloud.google.com)
1. Pick/create a project. **APIs & Services → Enable APIs** → enable **Gmail API** and **Google Calendar API**.
2. **APIs & Services → Credentials → Create credentials → Service account.** Name it `founderos`. Create.
3. Open the service account → **Keys → Add key → Create new key → JSON**. Download it. (This is the file FounderOS reads.)
4. On the service account's **Details** page, copy its **Unique ID** (a long number — the OAuth client ID).

### A2. Authorize domain-wide delegation (Google Workspace Admin — admin.google.com)
1. **Security → Access and data control → API controls → Domain-wide delegation → Add new.**
2. **Client ID** = the Unique ID from A1.4.
3. **OAuth scopes** (comma-separated, exactly):
   ```
   https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/calendar.events
   ```
4. **Authorize.**

### A3. Put the JSON on the VPS
```bash
# from your machine — copy the downloaded JSON to the box
scp -i ~/.ssh/founderos_deploy ~/Downloads/founderos-sa.json founderos@95.217.162.12:/opt/founderos/secrets/google-sa.json
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12 'chmod 600 /opt/founderos/secrets/google-sa.json'
```

### A4. Set the env vars (durably, in the `PROD_DOTENV` GitHub secret)
Add these lines to the prod `.env` content that `PROD_DOTENV` encodes:
```
GMAIL_BACKEND=googleapis
CALENDAR_BACKEND=googleapis
GOOGLE_APPLICATION_CREDENTIALS=/opt/founderos/secrets/google-sa.json
GOOGLE_SUBJECT_TURICKS=hello@turicks.com        # ← the mailbox to send/read as
# add GOOGLE_SUBJECT_NAGGAR / GOOGLE_SUBJECT_PERSONAL later for those accounts
```
Update the secret (one clean way):
```bash
# on the VPS: edit the live .env, then re-encode it into the GitHub secret
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12   # then: nano /opt/founderos/.env  (add the 4 lines)
# back on your machine, with gh authenticated to the repo:
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12 'base64 -w0 /opt/founderos/.env' | gh secret set PROD_DOTENV
```
> The deploy self-heals the DB password from `.env` (fix #243), so editing `.env` on the box is safe. Do NOT push a Mac `.env.production` — it carries a stale DB password.

### A5. Deploy + verify
1. Merge **PR #245** (the combined branch) → CD deploys the googleapis backend.
2. Verify live (evidence, not vibes):
```bash
curl -s http://127.0.0.1:3001/health | python3 -m json.tool   # expect gmail_active: "up", googleapis_gmail: up
```
3. In Telegram, ask the bot to send a test email → approve the HITL card → confirm a real `action_log` row with `backend: "googleapis"`.

---

## Part B — Unblock the judge + claude_code executor
1. **Anthropic key:** console.anthropic.com → **API keys → Create key** (`sk-ant-…`).
2. Add **both** to prod `.env` / `PROD_DOTENV` (same value):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   CLAUDE_EXECUTOR_API_KEY=sk-ant-...
   ```
   - `ANTHROPIC_API_KEY` → activates the Claude judge (gate 2 of outbound copy).
   - `CLAUDE_EXECUTOR_API_KEY` → switches `claude_code` to **API billing** instead of the maxed-out subscription (fixes "hit your monthly spend").
3. Redeploy. Verify `claude_code` works by asking the engineering dept to run a trivial build task in Telegram.

## Part C — Activate the Apify research engine
1. **Apify token:** apify.com → **Settings → API & Integrations** → copy the personal API token (`apify_api_…`).
2. Add to prod `.env` / `PROD_DOTENV`:
   ```
   APIFY_TOKEN=apify_api_...
   ```
3. Redeploy. Research scraping (`scrape_url`, `deep_research`, `crawl_site`) now uses Apify instead of the keyless fallback.

---

## Part D — Remaining phases (gated, in order)

- **Phase 3 — Company hierarchy (gated on Part B).** Once `claude_code` works: reconcile `src/agents/prompts/supervisor.ts` so the parent routes to `revenue` when the subgraph is on, flip `ENGINEERING_SUBGRAPH=1` + `REVENUE_SUBGRAPH=1`, then run the 3-level HITL MTProto QA (`scripts/e2e-telegram-qa.ts`) — reject→no `action_log` row, approve→exactly one. Code is intentionally NOT written yet (rule #19: don't ship unverified routing).
- **Phase 4 — Multi-business.** Parameterize the company-facing prompts by `getCompany(tenant)` + a `/company <key>` command, so Naggar runs in its own voice through the same graph. (Defer SaaS multi-tenancy to Phase E.)
- **Phase 5 — Jarvis ops cockpit.** Wire audit/action-log viewer, token+cost observability, knowledge search, dept/MCP/hierarchy state panels onto the existing `src/gateway/web.ts` endpoints. Fully buildable + verifiable locally.
- **Phase 6 — Repo + LinkedIn.** Flagship README, refreshed architecture diagrams, demo artifact, `v1.0.0` tag, positioning vs Hermes/OpenClaw/Antigravity, and the build-in-public launch sequence (dogfood the marketing dept).

## Quick reference
- SSH: `ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12` (user is `founderos`, NOT root). Repo `/opt/founderos`. Health `:3001/health`.
- Deploy = merge to `main` (CD). Combined deploy unit = **PR #245**.
- Never `git add -A` (the `.env.prod` gitignore gap). Never `docker compose down -v` (drops the DB).
