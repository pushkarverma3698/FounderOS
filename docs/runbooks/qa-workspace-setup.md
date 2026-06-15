# Runbook: QA auditor workspace on the VPS

## One-time setup
```bash
# As root on 95.217.162.12
useradd -m -s /bin/bash founderos-qa || true
git clone https://github.com/pushkarverma3698/FounderOS.git /opt/founderos-qa
chown -R founderos-qa:founderos-qa /opt/founderos-qa
sudo -u founderos-qa bash -c 'cd /opt/founderos-qa && pnpm install --frozen-lockfile'
# Provide /opt/founderos-qa/.env (DATABASE_URL read-only role preferred, TELEGRAM_BOT_TOKEN,
# FOUNDER_CHAT_ID, GITHUB_TOKEN with repo scope, ANTHROPIC_API_KEY for the judge gate).
```

## Cron (replaces the disabled inline version)
```cron
30 17 * * 0 cd /opt/founderos-qa && QA_DIR=/opt/founderos-qa bash scripts/weekly-qa-audit.sh >> /var/log/founderos-qa.log 2>&1
```
Install as the `founderos-qa` user: `sudo -u founderos-qa crontab -e`.

## On-demand
`cd /opt/founderos-qa && journalctl -u founderos --since "7 days ago" -o cat | pnpm logreview --days=7`
(harvest only — zero Claude tokens; run the orchestrator for the full Stage-3 + PR flow.)

## Safety
- `founderos-qa` has NO write access to `/opt/founderos` (the live deploy).
- The orchestrator never merges. Humans merge PRs.
- The old inline cron under user `founderos` stays DISABLED (commented out 2026-06-15).
