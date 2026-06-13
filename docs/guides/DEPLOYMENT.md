# FounderOS — Production Deployment (Hetzner VPS + systemd + GitHub Actions CD)

This is the canonical runbook for running FounderOS 24/7. It reflects two hard
constraints that rule out the obvious "just Dockerize it" / "serverless" paths:

1. **Single-instance long-polling bot.** grammy long-polls Telegram. Two
   instances → `409 Conflict`. The app holds a PID-file lock
   (`src/infra/single-instance.ts`); the host must run exactly one process.
2. **The `claude` executor spawns the CLI from PATH.**
   `src/tools/claude-code.ts` runs `claude -p` as a subprocess using the host's
   stored OAuth credentials. A stock container has neither the binary nor the
   login, so the app runs **native under systemd**, not in Docker. Only Postgres
   runs in Docker.

**Architecture:** `Hetzner CX22 (~€4.5/mo) → systemd(app) + docker(postgres) + claude CLI`.
No load balancer, no Redis (SaaS-phase), no managed DB. See ADR-021.

---

## 1. Provision the VPS

- **Hetzner CX22** — 2 vCPU / 4 GB / 40 GB, Ubuntu 24.04. (4 GB matters: Node +
  Postgres + a `claude` subprocess + `pnpm build` will OOM a 1 GB box.)
- Add your SSH key during creation. Harden:

```bash
# As root on the fresh box
apt update && apt -y upgrade
adduser --disabled-password --gecos "" founderos
usermod -aG sudo founderos
# Passwordless restart so the deploy script can restart the service:
echo 'founderos ALL=(ALL) NOPASSWD: /bin/systemctl restart founderos' \
  > /etc/sudoers.d/founderos && chmod 440 /etc/sudoers.d/founderos
# Firewall: SSH only; the bot is outbound long-poll, /health stays on localhost.
ufw allow OpenSSH && ufw --force enable
```

## 2. Install runtime deps (as `founderos`)

```bash
# Node 22 (fnm keeps it on PATH for systemd via the unit's Environment=PATH)
curl -fsSL https://fnm.vercel.app/install | bash && source ~/.bashrc
fnm install 22 && fnm default 22
corepack enable && corepack prepare pnpm@9 --activate

# Docker (for Postgres)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker founderos   # re-login after this

# Claude Code CLI — REQUIRED for the claude_code executor
curl -fsSL https://claude.ai/install.sh | bash   # or npm i -g @anthropic-ai/claude-code
claude login                                      # one-time interactive OAuth (Pro)
which claude                                       # confirm it resolves on PATH
```

> **Verify the executor auth before relying on it.** Run `claude -p "say hi"`
> as the `founderos` user. If that works headlessly, the in-app executor will
> too. This is the single riskiest unknown in the deploy.

## 3. Clone + configure

```bash
sudo mkdir -p /opt/founderos && sudo chown founderos:founderos /opt/founderos
git clone https://github.com/pushkarverma3698/FounderOS.git /opt/founderos
cd /opt/founderos
cp .env.example .env && chmod 600 .env
nano .env   # fill DATABASE_URL, TELEGRAM_BOT_TOKEN/CHAT_ID, GOOGLE_GENERATIVE_AI_API_KEY, etc.
#   DATABASE_URL=postgresql://founderos:<STRONG_PW>@127.0.0.1:5432/founderos
```

## 4. Bring up Postgres + first build

```bash
POSTGRES_PASSWORD='<STRONG_PW>' docker compose -f deploy/postgres.compose.yml up -d
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm setup            # seed/setup-db (idempotent)
```

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

- **CI** (`.github/workflows/ci.yml`, already present): on every push/PR —
  `pnpm lint`, `pnpm test:unit`, and integration tests when secrets are set.
  `pnpm eval` runs **only on main** (live Gemini, non-deterministic — never gate
  PRs on it).
- **CD** (`.github/workflows/deploy.yml`, new): `workflow_run` triggers on a
  **successful CI run on main**, then SSHes in and runs `deploy/deploy.sh`
  (fetch → install → lint → build → migrate → `systemctl restart` → `/health`
  check). The old instance keeps running until the very last step, so a failed
  build never takes prod down.

### Required GitHub repo secrets (Settings → Secrets → Actions)

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | VPS IP / hostname |
| `DEPLOY_USER` | `founderos` |
| `DEPLOY_PORT` | `22` |
| `DEPLOY_SSH_KEY` | private key whose public half is in `founderos`'s `~/.ssh/authorized_keys` (use a **dedicated deploy key**, not your personal one) |

The CI `eval-and-update-readme` job also needs `GOOGLE_GENERATIVE_AI_API_KEY`,
`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (already referenced).

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
| Hetzner CX22 | ~€4.50 |
| Hetzner Storage Box (backups, optional) | ~€3.20 (BX11, 1 TB) |
| Claude Pro (executor) | existing sub |
| Gemini / Composio | usage-based |
| **Floor** | **~€5/mo + existing subs** |

## When to revisit (→ EC2 / managed)

This setup is right for single-tenant Phase D. Move to EC2 + RDS + a real
orchestrator only at **Phase E (SaaS / multi-tenancy)** when you need managed
backups, read replicas, and horizontal scale. Until then it's YAGNI (rule #17).
