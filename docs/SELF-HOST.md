# Self-host FounderOS

Your own single-tenant FounderOS on a fresh Ubuntu 24.04 VPS: one Telegram bot that only answers you,
your own database, your own model key. Plan on under an hour, most of it package downloads and the
first build.

This is one operator per box. There is no multi-user mode. Several values in the code are still the
original author's; [self-host-hardcodes.md](self-host-hardcodes.md) lists them. None stops the bot.

## What you need before you start

| Need | Where to get it |
|------|-----------------|
| A VPS: Ubuntu 24.04, 2 vCPU, 4 GB RAM, 20 GB disk, root or sudo | Any provider. Postgres runs on it, in a container |
| A Telegram bot token | Message @BotFather, `/newbot` |
| Your Telegram user id (a number) | Message @userinfobot |
| A GitHub token with `repo` scope | github.com, Settings, Developer settings, Personal access tokens |
| One model API key | Google AI Studio, Anthropic, OpenRouter or OpenAI |

The VPS needs outbound internet (apt, GitHub, Docker Hub, your model provider). It needs no inbound
port: the bot polls Telegram, and `/health` listens on `127.0.0.1` only.

## Variables

Every variable the code reads is in [.env.example](../.env.example) with a one-line comment. These are
the ones the installer asks for or sets.

Core (the installer generates these; you do not supply them)

| Variable | Value |
|----------|-------|
| `DATABASE_URL` | Local Postgres, random password |
| `FOUNDEROS_DATA_ROOT` | `FOUNDEROS_DATA_DIR`, default `/opt/founderos-data` |
| `FOUNDEROS_SKIP_FOUNDER_SEED` | `1`, so your database does not get the original author's profile |

Telegram (required)

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `TELEGRAM_CHAT_ID` | Your numeric Telegram user id. The bot ignores every other chat |

GitHub (required)

| Variable | Value |
|----------|-------|
| `GITHUB_TOKEN` | Token with `repo` scope |

Models (one key required)

| Variable | Notes |
|----------|-------|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Default model `google-genai:gemini-2.5-flash` |
| `OPENROUTER_API_KEY` | Default model `openrouter:openai/gpt-4o-mini` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Also set `AGENT_MODEL=anthropic:<model>` or `openai:<model>`; the installer does not guess a model name that may be retired |
| `AGENT_MODEL` | Optional. `provider:model`. Its provider key must be set |

Optional

| Variable | Use |
|----------|-----|
| `FOUNDEROS_DIR` | App checkout. Default `/opt/founderos` |
| `FOUNDEROS_DATA_DIR` | State that survives deploys. Default `<FOUNDEROS_DIR>-data` |
| `FOUNDEROS_REPO_URL` | Repo to clone. Default: the origin of the checkout you run the script from |
| `DEPLOY_BRANCH` | Branch to deploy. Default `main` |
| Google (`GWS_*`, `GOOGLE_*`) and Antigravity (`AGENT_DISPATCH_*`, `PR_BRAIN_*`) | See `.env.example`. Not needed to start |

## Install

1. SSH in as a sudo user and clone the repo anywhere:

   ```bash
   git clone https://github.com/pushkarverma3698/FounderOS.git ~/founderos-src
   cd ~/founderos-src
   ```

2. Put the four required values in a file only you can read:

   ```bash
   install -m 600 /dev/null ~/founderos.env
   nano ~/founderos.env
   ```

   ```
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_CHAT_ID=
   GITHUB_TOKEN=
   OPENROUTER_API_KEY=
   ```

   Use the model key you have in place of `OPENROUTER_API_KEY`.

3. Check the inputs. This changes nothing on the box:

   ```bash
   sudo -E ./deploy/install.sh --env-file ~/founderos.env --check-env
   ```

   A missing value stops it with exit 2 and a list of what is missing.

4. Install:

   ```bash
   sudo -E ./deploy/install.sh --env-file ~/founderos.env
   ```

The script then:

1. Installs Docker, ffmpeg, jq, Node 22, pnpm 9 and the GitHub CLI.
2. Creates the `founderos` user, clones the repo into `FOUNDEROS_DIR` and writes its `.env` (mode 600).
3. Installs `founderos.service`.
4. Runs `deploy/deploy.sh`: starts Postgres (pgvector) and Ollama in containers, builds, migrates,
   restarts the service and waits for `/health`.
5. Runs `deploy/sync-daemons.sh` for the coding-pipeline daemons and sockets.

`sudo -E` is what passes your shell variables through; with `--env-file` you do not need them in the
shell. Values are never printed. Delete `~/founderos.env` afterwards: the app has its own copy in
`$FOUNDEROS_DIR/.env`.

Re-running is safe. Packages, users and files change only when they differ, an existing `.env` is never
rewritten, and a box already running the branch head is left alone. To update later, run it again, or
run `deploy/deploy.sh` from `$FOUNDEROS_DIR` as the prod box does.

## Verify

1. On the box:

   ```bash
   systemctl is-active founderos        # active
   curl -fsS http://127.0.0.1:3001/health
   journalctl -u founderos -n 30 --no-pager
   ```

2. In Telegram, send your bot `/where`. It replies with the work summary per repo (done this week, in flight, blocked); on a new box it is mostly empty, and any reply proves the bot is wired to your chat.
3. Send a plain question, such as "what can you do?". A reply means Telegram, the database and your
   model key work end to end.

If the service is not active, `journalctl -u founderos -n 50` names the missing variable or the
failing step. A rejected token or a model key without credit shows up there too.

## What does not work without the optional pieces

| Feature | Needs | Without it |
|---------|-------|------------|
| Chat, memory, planning, tools that read GitHub | The four required values | Works |
| `/task`, agent-written PRs, PR review | The dispatch daemons from `deploy/sync-daemons.sh`, cron lines for them (not installed by any script; copy them from `deploy/vps-daemons/README.md`), an `antigravity` or Claude CLI login, and your repos in `ISSUE_REPOS` | Bot answers, but nothing picks up tasks |
| `/task` on your own repos | A code change: the repo list in `src/tools/dispatch-repos.ts` is the original author's (see the inventory, rows 1-4) | The bot refuses repos not on that list |
| Gmail, Calendar, Drive | `/login` (Google) and the `GWS_*` OAuth files | Those tools report that no account is connected |
| Antigravity login | `/login agy` (see `/login`) and the `antigravity` user | The agy engine is unavailable |
| Job-hunt lane | Profile data under `FOUNDEROS_DATA_ROOT` | Off |
| LinkedIn, Instagram, Facebook posting | Their tokens in `.env` | Off |

## Known limits

1. The `agy-login` and `fos-job` systemd units keep `/opt/founderos` and `/home/founderos` paths. With a
   non-default `FOUNDEROS_DIR`, the daemons part will not work until you edit them.
2. Skipping the founder seed means the profile rows are empty. You fill in your own context by telling
   the bot, or with `scripts/seed-founder-context.ts` as a template.
3. Postgres runs in Docker (`deploy/stack.compose.yml`), the same as the original box, not from apt.
4. Prompts and menus still carry the original author's names and domains. See
   [self-host-hardcodes.md](self-host-hardcodes.md).

## Uninstall

```bash
sudo systemctl disable --now founderos
sudo docker compose -f /opt/founderos/deploy/stack.compose.yml down        # add -v to delete the database
sudo rm /etc/systemd/system/founderos.service && sudo systemctl daemon-reload
```
