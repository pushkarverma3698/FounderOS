# Runbook: QA auditor workspace on the VPS

## One-time setup
Runs as the **existing `founderos` user** — the same account where the `claude` CLI is already
logged in (Pro plan). No new OS user, no new Claude login. Isolation is by a SEPARATE clone
(`/opt/founderos-qa`), so QA git operations never touch the live deploy at `/opt/founderos`.

```bash
# As the founderos user on YOUR_VPS_IP (NOT root, NOT a new user)
git clone https://github.com/pushkarverma3698/FounderOS.git /opt/founderos-qa
cd /opt/founderos-qa && pnpm install --frozen-lockfile
# Provide /opt/founderos-qa/.env (DATABASE_URL read-only role preferred, TELEGRAM_BOT_TOKEN,
# FOUNDER_CHAT_ID, GITHUB_TOKEN with repo scope).
# NOTE: Stage 3 uses the `claude` CLI authenticated via the existing Pro-plan login (shared
# quota, same as the claude_code executor) — NO ANTHROPIC_API_KEY, NO extra login. The login
# already on this box is reused. Verify once: `claude -p "say ok"`.
```

## Cron (replaces the disabled inline version)
```cron
30 17 * * 0 cd /opt/founderos-qa && QA_DIR=/opt/founderos-qa bash scripts/weekly-qa-audit.sh >> /var/log/founderos-qa.log 2>&1
```
Install on the existing `founderos` user's crontab: `crontab -e`.

## On-demand
`cd /opt/founderos-qa && journalctl -u founderos --since "7 days ago" -o cat | pnpm logreview --days=7`
(harvest only — zero Claude tokens; run the orchestrator for the full Stage-3 + PR flow.)

## Safety
- Isolation is by **separate clone directory** only. The `founderos` OS user owns both
  `/opt/founderos` (live) and `/opt/founderos-qa` (QA). QA git operations only target the
  `/opt/founderos-qa` remote — they never write to `/opt/founderos`.
- The orchestrator never merges. Humans merge PRs.
- The old inline cron under user `founderos` stays DISABLED (commented out 2026-06-15).
