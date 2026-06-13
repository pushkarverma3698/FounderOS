# FounderOS — Production Deployment (Hetzner VPS + systemd + GitHub Actions CD)

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
| `OPENROUTER_API_KEY` | (optional) 503 fallback, used by integration tests |
| `DATABASE_URL` · `TELEGRAM_BOT_TOKEN` · `TELEGRAM_CHAT_ID` | used by the `main`-only eval job |

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
# [boot] Composio (...)      MISSING  comms/marketing sends disabled
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

## When to revisit (→ EC2 / managed)

This setup is right for single-tenant Phase D. Move to EC2 + RDS + a real
orchestrator only at **Phase E (SaaS / multi-tenancy)** when you need managed
backups, read replicas, and horizontal scale. Until then it's YAGNI (rule #17).
