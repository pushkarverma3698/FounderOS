# FounderOS — Production Deployment (Hetzner VPS + systemd + GitHub Actions CD)

> **STATUS: LIVE in production since 2026-06-14.** `main` auto-deploys to the VPS
> via GitHub Actions; the bot runs 24/7 under systemd, Postgres + Ollama in Docker,
> and the full CI → CD → `/health` loop is green. Before touching the pipeline,
> read [Day-1 live deploy: lessons & gotchas](#day-1-live-deploy-lessons--gotchas)
> — it captures the exact failures the first deploy hit and will save you those hours.

This is the canonical runbook for running FounderOS 24/7. It reflects two hard
constraints that rule out the obvious "just Dockerize it" / "serverless" paths:

1. **Single-instance long-polling bot.** grammy long-polls Telegram. Two
   instances → `409 Conflict`. The app holds a PID-file lock
   (`src/infra/single-instance.ts`); the host must run exactly one process.
2. **The `claude` executor spawns the CLI from PATH.**
   `src/tools/claude-code.ts` runs `claude -p` as a subprocess using the host's
   stored OAuth credentials (or `CLAUDE_EXECUTOR_API_KEY` as a fallback). A stock
   container has neither the binary nor the login, so the app runs **native under
   systemd**, not in Docker. Postgres and Ollama run in Docker.

**Architecture:** `Hetzner CX32 (~€9/mo) → systemd(app) + docker(postgres+ollama) + claude CLI`.
No load balancer, no Redis (SaaS-phase), no managed DB. See ADR-021.

---

## 1. Provision the VPS

- **Hetzner CX32** — 4 vCPU / 8 GB / 80 GB, Ubuntu 24.04. (8 GB matters: Node +
  Postgres + Ollama loading `nomic-embed-text` + a `claude` subprocess + `pnpm build`
  will OOM a 4 GB box. CX22 is no longer sufficient once Ollama is in the stack.)
- Add your SSH key during creation. Harden:

```bash
# As root on the fresh box
apt update && apt -y upgrade
adduser --disabled-password --gecos "" founderos
usermod -aG sudo founderos
# Passwordless restart so the deploy script can restart the service:
echo 'founderos ALL=(ALL) NOPASSWD: /bin/systemctl restart founderos' \
  > /etc/sudoers.d/founderos && chmod 440 /etc/sudoers.d/founderos
# Firewall: SSH only. Postgres (5432) and Ollama (11434) bind to 127.0.0.1
# in deploy/stack.compose.yml — they are NEVER reachable from the internet.
ufw allow OpenSSH && ufw --force enable
```

## 2. Install runtime deps (as `founderos`)

```bash
# Node 22 — system-wide via NodeSource (NOT fnm/nvm: systemd doesn't source
# .bashrc, so fnm shim dirs never appear on the service's PATH).
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs       # puts node+npm at /usr/bin
sudo npm install -g pnpm@9           # puts pnpm at /usr/bin/pnpm
node --version && pnpm --version     # confirm

# sqlite3 — needed by the one-time Chroma→pgvector migration script
sudo apt-get install -y sqlite3

# Docker (for Postgres + Ollama)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker founderos   # re-login after this

# Claude Code CLI — REQUIRED for the claude_code executor
sudo npm install -g @anthropic-ai/claude-code   # puts claude at /usr/local/bin
claude login                                     # one-time interactive OAuth (Pro)
which claude                                     # confirm it resolves on PATH
```

> **Executor dual-auth.** Two auth paths for `claude -p`:
> 1. **OAuth (default):** `claude login` above persists credentials to
>    `~/.claude/.credentials.json`. Leave `CLAUDE_EXECUTOR_API_KEY` empty in `.env`.
> 2. **API key fallback:** set `CLAUDE_EXECUTOR_API_KEY=sk-ant-...` in `.env` if
>    OAuth is impractical (CI, containers, headless). The executor will use the key
>    directly; no `claude login` needed.
>
> **Verify before relying on it.** Run `claude -p "say hi"` as the `founderos`
> user. If that works headlessly, the in-app executor will too. This is the
> single riskiest unknown in the deploy.

## 3. Clone + configure

```bash
sudo mkdir -p /opt/founderos && sudo chown founderos:founderos /opt/founderos
git clone https://github.com/pushkarverma3698/FounderOS.git /opt/founderos
cd /opt/founderos
cp .env.example .env && chmod 600 .env
nano .env   # fill DATABASE_URL, TELEGRAM_BOT_TOKEN/CHAT_ID, GOOGLE_GENERATIVE_AI_API_KEY, etc.
#   DATABASE_URL=postgresql://founderos:<STRONG_PW>@127.0.0.1:5432/founderos
```

> This hand-edited `.env` is only the **bootstrap**. From the second deploy on,
> CD renders `/opt/founderos/.env` from the `PROD_DOTENV` GitHub secret on every
> run — so you never SSH in to edit prod env again. See
> [Managing production env without SSH](#managing-production-env-without-ssh).

## 4. Bring up Postgres + Ollama + first build

```bash
# Start Postgres (pgvector/pgvector:pg16) + Ollama — both loopback-only.
POSTGRES_PASSWORD='<STRONG_PW>' docker compose -f deploy/stack.compose.yml up -d

# Pull the embedding model (no-op if already cached; also runs on every deploy.sh)
docker exec founderos-ollama ollama pull nomic-embed-text

pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate       # creates personal_rag, turicks_brain, pgvector extension, etc.
pnpm setup            # seed/setup-db (idempotent)
```

### Knowledge-stores population (first time only)

The pgvector tables start empty. If you have existing Chroma databases
(`personal-rag` / `turicks-brain-rag`) on the host, migrate them:

```bash
# Reads from ~/Projects/personal-rag/data/chroma_db/chroma.sqlite3
# and ~/Projects/turicks-brain-rag/data/chroma_db/chroma.sqlite3,
# re-embeds via Ollama, inserts into personal_rag + turicks_brain tables.
# Idempotent: TRUNCATE → embed → insert. Safe to re-run.
npx tsx --env-file=.env scripts/migrate-chroma-to-pgvector.ts
```

After migration, the old Chroma HTTP services at :8765/:8766 can be shut down —
they are no longer used. All RAG queries now go directly to Postgres via pgvector.

## 5. Install the systemd service

```bash
sudo cp deploy/founderos.service /etc/systemd/system/founderos.service
sudo systemctl daemon-reload
sudo systemctl enable --now founderos
systemctl status founderos
journalctl -u founderos -f          # watch boot; expect "8 departments compiled", 0× 409
curl -fsS http://127.0.0.1:3001/health   # {"status":"ok",...}
```

## 6. Nightly DB backup (cron)

```bash
crontab -e
# 3am daily dump + 14-day prune (off-box sync recommended — see backup-db.sh)
0 3 * * *  /opt/founderos/deploy/backup-db.sh >> /var/log/founderos-backup.log 2>&1
```

## 7. Uptime monitoring (closes the loop)

`/health` is bound to localhost, so expose a tiny check or use a heartbeat.
Simplest: a 5-min cron that curls `/health` and pings a Telegram/UptimeRobot
webhook on failure. The app's `/halt` kill switch (ADR-020) pauses work without
killing the process — distinct from a crash.

---

## CI/CD pipeline

**`main` IS production** (single-tenant — there is no separate `production`
branch). Merge to `main` → CI runs → on success CD deploys. That's the whole loop.

- **CI** (`.github/workflows/ci.yml`): on every push/PR —
  `pnpm lint` + `pnpm test:unit` (unconditional, need no secrets), plus
  integration tests and (on `main` only) `pnpm eval` **when the relevant secret
  is present**. The skip is done at the *step* level via an `env` check —
  **never** put `secrets.*` in a job-level `if:`; that is illegal and silently
  invalidates the entire workflow file (every job fails in 0s).
- **CD** (`.github/workflows/deploy.yml`): `workflow_run` triggers on a
  **successful CI run on `main`**, renders the prod `.env` from `PROD_DOTENV`,
  then SSHes in and runs `deploy/deploy.sh`
  (fetch → install → lint → build → migrate → `systemctl restart` → `/health`).
  The old instance keeps running until the very last step, so a failed build
  never takes prod down. There's also a `workflow_dispatch` button in the
  Actions tab for manual deploys.

### Required GitHub repo secrets (Settings → Secrets and variables → Actions)

| Secret | Purpose / value |
|---|---|
| `DEPLOY_HOST` | VPS IP / hostname |
| `DEPLOY_USER` | `founderos` |
| `DEPLOY_PORT` | `22` |
| `DEPLOY_SSH_KEY` | **dedicated** deploy private key whose public half is in `founderos`'s `~/.ssh/authorized_keys` (not your personal key) |
| `PROD_DOTENV` | the FULL production `.env`, **base64-encoded** — CD renders it to `/opt/founderos/.env` on every deploy (see below) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | used by integration tests + the `main`-only eval job |
| `OPENROUTER_API_KEY` | **production resilience — set this.** Arms the cross-provider failover (`model.ts` → GPT-4o-mini) so a Gemini quota/billing lapse degrades gracefully instead of taking the whole office down. Without it the bot is 100% down on any Gemini outage (this fired 2026-06-16 when Gemini credits depleted). Put it in `PROD_DOTENV` too, not just here. Verify: temporarily point `AGENT_MODEL` at a dead key and confirm a real turn returns with `provider: "openrouter"` in the trace. |
| `DATABASE_URL` · `TELEGRAM_BOT_TOKEN` · `TELEGRAM_CHAT_ID` | used by the `main`-only eval job |

**Image delivery (S3):** `marketing.generate_image` stores bytes in object storage and
returns an asset pointer. If `GOOGLE_GENERATIVE_AI_API_KEY` is set but
`STORAGE_BUCKET` + `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` are missing, the
tool generates the image (real spend) then dead-ends at upload — boot + deploy now
warn loudly. Include all three in `PROD_DOTENV` (or `STORAGE_ENDPOINT_URL` for R2/MinIO).

`GITHUB_TOKEN` is provided automatically by Actions — do not create it.

### Managing production env without SSH

The prod `.env` is a **rendered artifact**, not a hand-maintained file. To change
any production secret or setting:

```bash
# 1. Keep the real prod env locally (gitignored — NEVER commit it).
#    Start from .env.example and fill in production values.
nano .env.production

# 2. Push it as the base64 secret (one line, transport-safe through SSH).
base64 -w0 .env.production | gh secret set PROD_DOTENV   # Linux
base64 .env.production | tr -d '\n' | gh secret set PROD_DOTENV   # macOS

# 3. Redeploy: either merge to main, or hit "Run workflow" on the Deploy action.
gh workflow run deploy.yml
```

On deploy, CD base64-decodes `PROD_DOTENV` to `/opt/founderos/.env` (chmod 600),
**aborting if the decoded file has no `DATABASE_URL`** (guards against clobbering
a good `.env` with a malformed secret). No SSH, fully auditable via the Actions
run log. *Upgrade path:* when you want version-controlled env history, switch to
a SOPS-encrypted `.env.production` committed to the repo + an `age` key on the
VPS — same render-on-deploy idea, but with a git diff per change.

### Fail-fast in production

`NODE_ENV=production` makes `GOOGLE_GENERATIVE_AI_API_KEY` **required** at boot
(`src/core/config.ts`) — a misconfigured box crashes loudly instead of booting
"fine" and dying on the first message. On startup the bot logs a capability
report (`src/infra/boot-report.ts`); check drift with:

```bash
journalctl -u founderos | grep '\[boot\]'
# [boot] LLM (Gemini)        LIVE   ...
# [boot] Google Workspace (gws)  LIVE/MISSING  ...
# [boot] LinkedIn (direct API)   LIVE/MISSING  ...
```

---

## Operations cheat-sheet

```bash
# Logs
journalctl -u founderos -f
journalctl -u founderos --since "10 min ago"

# Lifecycle
sudo systemctl restart founderos      # safe — single-instance lock + graceful drain
sudo systemctl stop founderos
sudo systemctl status founderos

# Manual deploy (same script CD runs)
cd /opt/founderos && ./deploy/deploy.sh

# DB shell / backup
docker exec -it founderos-postgres psql -U founderos
./deploy/backup-db.sh
```

## Cost

| Item | Monthly |
|---|---|
| Hetzner CX32 | ~€9.00 (4 vCPU / 8 GB — required for Ollama) |
| Hetzner Storage Box (backups, optional) | ~€3.20 (BX11, 1 TB) |
| Claude Pro (executor) | existing sub |
| Gemini / Composio | usage-based |
| **Floor** | **~€9/mo + existing subs** |

## Day-1 live deploy: lessons & gotchas

The first real CD deploy (2026-06-14) was green in CI but failed three times on the
box before going live. Every failure was a config/credential drift, not a code bug.
All are now fixed; documented here so they never cost time again.

### 1. `secrets.*` in a job-level `if:` silently kills the whole workflow
CI "passed" in 0 s on every run because a job-level `if: ${{ secrets.X != '' }}`
is **illegal** — GitHub invalidates the entire workflow file, so nothing runs.
**Rule:** gate on secrets at the *step* level via `env:` (`if: env.X != ''`), and
keep `lint` + `test:unit` unconditional. (Already encoded in `ci.yml`.)

### 2. DB `28P01` — the Postgres volume password lives nowhere on disk
`POSTGRES_PASSWORD` only sets the role password the **first time** the data volume
initializes; later changes to the env are no-ops. So the live role password matched
neither `.env.production` nor the container env nor the running process
(`--env-file` loads into the JS runtime, not `/proc/<pid>/environ`). The deploy's
`.env` render overwrote the only working copy → `password authentication failed`.
**Fix pattern (no SSH secrets printed):** reset the role to a fresh password with a
local-superuser `docker exec`, write the matching `DATABASE_URL` into the box `.env`,
then re-sync `PROD_DOTENV` from the corrected `.env`:
```bash
# on the box — docker exec is local superuser, no password prompt
docker exec founderos-postgres psql -U founderos -d founderos \
  -c "ALTER USER founderos PASSWORD '<fresh-alnum-pw>';"
# then update DATABASE_URL in /opt/founderos/.env to match, and:
base64 -w0 /opt/founderos/.env | gh secret set PROD_DOTENV
```

### 3. Boot checks key *presence*, not *validity*
`config.ts` fail-fast requires `GOOGLE_GENERATIVE_AI_API_KEY` to **exist** in prod —
but a present-yet-invalid key boots fine and then every LLM call returns
`400 API_KEY_INVALID`. The first deploy shipped a stale key set in `.env.production`
(Google/GitHub/Firecrawl/Composio all differed from the working dev `.env`).
**Always validate keys before trusting a deploy:**
```bash
# Gemini
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$KEY" \
  -H 'Content-Type: application/json' -d '{"contents":[{"parts":[{"text":"hi"}]}]}'
# GitHub
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOK" https://api.github.com/user
# Composio
curl -s -o /dev/null -w "%{http_code}\n" -H "x-api-key: $K" \
  https://backend.composio.dev/api/v3/connected_accounts
```
`200` = good. The `[boot]` capability report (`boot-report.ts`) tells you which
integrations are LIVE vs MISSING, but it can't catch an invalid-but-present key —
the curl checks above can.

### 4. The single source of truth for prod env is `PROD_DOTENV` + the box `.env`
The local `.env.production` on a dev machine can drift (stale passwords/keys).
After any in-place fix on the box, **re-sync the secret from the box** and refresh
your local copy — never re-push a stale local `.env.production` over a working
`PROD_DOTENV`:
```bash
# refresh local copy from the source of truth
scp -i ~/.ssh/<deploy_key> founderos@<host>:/opt/founderos/.env ./.env.production
```

### 5. Reliability fixes shipped alongside go-live
Two production reliability bugs found in the live founder-simulation E2E sweep were
fixed and deployed (PR #60): a persistent **thread-wedge after a recursion abort**
(now an unconditional checkpoint clear) and an intermittent **brand-validator retry
loop** (now bounded). Both are live-verified on the real Telegram path. See the QA
methodology in [rules/TESTING-RULES.md](../rules/TESTING-RULES.md) (rules 11–14) and
the `scripts/e2e-telegram-qa.ts` harness.

---

## When to revisit (→ EC2 / managed)

This setup is right for single-tenant Phase D. Move to EC2 + RDS + a real
orchestrator only at **Phase E (SaaS / multi-tenancy)** when you need managed
backups, read replicas, and horizontal scale. Until then it's YAGNI (rule #17).
