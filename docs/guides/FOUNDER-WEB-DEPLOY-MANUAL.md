# Founder Manual — Web Design / Proof Drop Deploy

> **Who does what:** FounderOS automates build → deploy → sales signal. You do one-time VPS setup, approve HITL cards in Telegram, and client-facing business steps.

---

## What the system does (automated)

| Step | Department | Tool | HITL? |
|------|------------|------|-------|
| Lead discovery | research | `search_web` + optional `publish_signal(lead_discovered)` | No |
| Copy / brief | marketing | `publish_signal(design_brief_ready)` | No |
| Build landing page | engineering | `claude_code` | **Yes** |
| Publish to web | engineering | `deploy_static_site` | **Yes** |
| Sales follow-up nudge | scheduler | auto `site_deployed` signal → sales | No (nudge only) |
| Proof Drop email | sales | `send_email` | **Yes** |

After you approve **deploy_static_site**, FounderOS:
1. Copies `index.html` (or a static directory) from `~/Projects/...` to the web root
2. Returns the public URL (e.g. `http://95.217.162.12/clients/langfuse/`)
3. Records `site_deployed` in Postgres for the sales sweep

---

## Your one-time VPS setup (founder only)

SSH: `founderos@95.217.162.12`

### 1. Install nginx (required for port 80 — no domain needed)

```bash
sudo apt update && sudo apt install -y nginx
sudo ufw allow 80/tcp    # optional but recommended
sudo ufw allow 8888/tcp  # only if you use manual python preview
```

### 2. Run the static host script

```bash
cd /opt/founderos
git pull origin main
bash scripts/vps-proof-nginx-setup.sh
```

This serves:
- `http://95.217.162.12/showcase-1/` — AgentOps showcase
- `http://95.217.162.12/clients/{slug}/` — per-client Proof Drops

### 3. Set public URL in `.env` (on VPS)

```bash
# /opt/founderos/.env
STATIC_SITE_PUBLIC_BASE_URL=http://95.217.162.12
```

Restart the bot after editing: `sudo systemctl restart founderos`

### 4. Optional — passwordless sudo for CI deploys

If GitHub Actions should deploy without your password:

```bash
sudo visudo -f /etc/sudoers.d/founderos-nginx
```

Add:

```
founderos ALL=(ALL) NOPASSWD: /usr/sbin/nginx, /bin/systemctl reload nginx, /bin/systemctl restart nginx, /bin/mkdir, /bin/cp, /bin/chown, /usr/bin/tee, /usr/bin/true
```

### 5. Optional — domain later

When you own DNS for `proof.turicks.com`, point an A record to `95.217.162.12`. The nginx config already answers for that hostname.

---

## Your daily workflow (Telegram)

### Morning demo / client build

1. **Message the bot** (example):
   > Build a cinematic landing page for AgentOps using the neon preset, then deploy it as showcase-1.

2. **Approve HITL #1** — `claude_code` (whole build, ~3–5 min on VPS)

3. **Approve HITL #2** — `deploy_static_site` (publishes to public URL)

4. **Open the URL** the bot returns, e.g. `http://95.217.162.12/showcase-1/`

5. **Sales follow-up** — scheduler surfaces `site_deployed`; ask sales dept for Proof Drop email or run yourself.

### Quick manual preview (no nginx)

If nginx is not up yet, temporary preview:

```bash
cd ~/www/proof.turicks.com/showcase-1
python3 -m http.server 8888 --bind 0.0.0.0
```

Open `http://95.217.162.12:8888/` in your browser. **Ctrl+C** stops the server (foreground process — use a second SSH tab).

---

## Verification commands (you or CI)

On VPS after `git pull`:

```bash
cd /opt/founderos
pnpm gate                    # lint + full test suite
pnpm eval:webdesign          # routing + deploy tool + signals
bash scripts/vps-live-showcase.sh   # deploy + HTTP verify
```

GitHub Actions: workflow **VPS Verify** with `live_only=true` runs the live showcase path.

---

## What only you can do (not automated)

| Task | Why |
|------|-----|
| `sudo apt install nginx` | Requires root |
| `ufw` / firewall rules | Requires root |
| Claude Code `claude login` on VPS | Interactive OAuth once |
| `TELEGRAM_TESTER_SESSION` for MTProto QA | Your Telegram account |
| Gumroad product upload | Business / Stripe |
| Client contracts & invoicing | Business |
| DNS for `proof.turicks.com` | Registrar |
| Merge PRs to `main` | Human gate |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `proof.turicks.com` → 502 | DNS not pointed OR nginx not installed — use IP URL |
| `vps-proof-nginx-setup.sh` fails at `tee` | Install nginx first (step 1) |
| Bot dies ~1s after start | Invalid `TELEGRAM_BOT_TOKEN` |
| `claude_code` fails | Run `claude login` as `founderos` OR set `CLAUDE_EXECUTOR_API_KEY` |
| Deploy returns home path not system | Passwordless sudo missing — site still works via `~/www` + manual nginx sync |
| http.server "stuck" | Normal — it's serving; open browser or use second terminal |

---

## Evidence bar (definition of done)

- [ ] `curl localhost:3001/health` → 200 on VPS
- [ ] `pnpm eval:webdesign` → all checks pass
- [ ] `http://95.217.162.12/showcase-1/` → AgentOps page (or `:8888` temp server)
- [ ] Telegram: build HITL approve → deploy HITL approve → URL in reply
- [ ] `action_log` row for `deploy_static_site` + `site_deployed` signal in `dept_signals`

---

## Mac vs VPS paths

| Location | Path |
|----------|------|
| VPS FounderOS | `/opt/founderos` |
| VPS builds | `~/Projects/agent-workspace/` |
| VPS web root (system) | `/var/www/clients/{slug}/` |
| VPS web root (fallback) | `~/www/clients/{slug}/` |
| Mac local dev | clone repo, `pnpm dev` — **not** `/opt/founderos` on Mac |

---

*Last updated: deploy_static_site tool + IP-based nginx (PR cursor/deploy-static-site-e2e-cb8b).*
