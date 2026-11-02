#!/usr/bin/env bash
# FounderOS - self-host bootstrap for a fresh Ubuntu 24.04 box.  Guide: docs/SELF-HOST.md
#
#   sudo -E ./deploy/install.sh [--env-file FILE] [--check-env] [--prepare-only]
#
# One script, no new machinery. It installs the host packages, creates the service user, clones the
# repo, writes .env, installs the systemd unit, then hands the real work to the scripts prod already
# uses: deploy/deploy.sh (build, migrate, restart, health) and deploy/sync-daemons.sh (daemons +
# job sockets). It does not duplicate either.
#
# Inputs (environment, or --env-file; the environment wins). Values are never printed.
#   required   TELEGRAM_BOT_TOKEN   from @BotFather
#              TELEGRAM_CHAT_ID     your Telegram user id (the bot answers only this chat)
#              GITHUB_TOKEN         a token with repo scope (issues and PRs for your repos)
#              one model key        GOOGLE_GENERATIVE_AI_API_KEY | ANTHROPIC_API_KEY |
#                                   OPENROUTER_API_KEY | OPENAI_API_KEY
#   optional   AGENT_MODEL          provider:model. Defaults for a Google or OpenRouter key; required
#                                   when the only key is Anthropic or OpenAI.
#              FOUNDEROS_DIR        where the app lives (default /opt/founderos)
#              FOUNDEROS_DATA_DIR   state that survives deploys (default <FOUNDEROS_DIR>-data)
#              FOUNDEROS_REPO_URL   repo to clone (default: this checkout's origin)
#              DEPLOY_BRANCH        branch to deploy (default main)
#
# Modes: --check-env validates the inputs and stops. --prepare-only does everything up to the deploy
# (packages, user, clone, .env, unit) and stops. No flag = the whole install.
#
# Re-running is safe: packages, users, files and the unit are only touched when they differ, an
# existing .env is never rewritten, and a box that is already running the branch head is left alone.
# Exit codes: 0 done, 1 a step failed, 2 an input is missing or invalid.

set -euo pipefail

# Every input this script reads. tests/unit/scripts/env-example-complete.test.ts checks each one is documented in .env.example.
INPUT_VARS=(TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID GITHUB_TOKEN GOOGLE_GENERATIVE_AI_API_KEY ANTHROPIC_API_KEY
  OPENROUTER_API_KEY OPENAI_API_KEY AGENT_MODEL FOUNDEROS_DIR FOUNDEROS_DATA_DIR FOUNDEROS_REPO_URL DEPLOY_BRANCH)

SELF_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="founderos" # fixed: deploy/founderos.service and deploy/systemd/*.service name it
MODE="full"
ENV_FILE=""

log() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --env-file) [ $# -ge 2 ] || die "--env-file needs a path" 2; ENV_FILE="$2"; shift 2 ;;
    --check-env) MODE="check"; shift ;;
    --prepare-only) MODE="prepare"; shift ;;
    -h|--help) sed -n '2,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" 2 ;;
  esac
done

# --- 1. inputs -------------------------------------------------------------------------------------
# The env file is read with grep, never sourced: a value in it cannot run code.
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || die "--env-file $ENV_FILE does not exist" 2
  for v in "${INPUT_VARS[@]}"; do
    [ -z "${!v:-}" ] || continue
    line="$(grep -E "^${v}=" "$ENV_FILE" | head -1 || true)"
    [ -n "$line" ] || continue
    val="${line#*=}"; val="${val%$'\r'}"; val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
    printf -v "$v" '%s' "$val"
    export "${v?}"
  done
fi

missing=()
for v in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID GITHUB_TOKEN; do
  [ -n "${!v:-}" ] || missing+=("$v")
done
if [ -z "${GOOGLE_GENERATIVE_AI_API_KEY:-}${ANTHROPIC_API_KEY:-}${OPENROUTER_API_KEY:-}${OPENAI_API_KEY:-}" ]; then
  missing+=("one model key: GOOGLE_GENERATIVE_AI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY or OPENAI_API_KEY")
fi
if [ "${#missing[@]}" -gt 0 ]; then
  {
    echo "install.sh: refusing to install, these required values are not set:"
    for m in "${missing[@]}"; do echo "  - $m"; done
    echo "Set them in the environment (sudo -E keeps it) or pass --env-file FILE. See docs/SELF-HOST.md."
  } >&2
  exit 2
fi
case "$TELEGRAM_CHAT_ID" in
  ''|*[!0-9-]*) die "TELEGRAM_CHAT_ID must be numeric (your Telegram user id, e.g. from @userinfobot)" 2 ;;
esac

# Default model per key. Anthropic and OpenAI model names change too often to pick one here.
if [ -z "${AGENT_MODEL:-}" ]; then
  if [ -n "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ]; then AGENT_MODEL="google-genai:gemini-2.5-flash"
  elif [ -n "${OPENROUTER_API_KEY:-}" ]; then AGENT_MODEL="openrouter:openai/gpt-4o-mini"
  else die "AGENT_MODEL is required with an Anthropic or OpenAI key (e.g. AGENT_MODEL=anthropic:<model>)" 2
  fi
fi
case "${AGENT_MODEL%%:*}" in
  google-genai) [ -n "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ] || die "AGENT_MODEL=$AGENT_MODEL needs GOOGLE_GENERATIVE_AI_API_KEY" 2 ;;
  anthropic) [ -n "${ANTHROPIC_API_KEY:-}" ] || die "AGENT_MODEL=$AGENT_MODEL needs ANTHROPIC_API_KEY" 2 ;;
  openrouter) [ -n "${OPENROUTER_API_KEY:-}" ] || die "AGENT_MODEL=$AGENT_MODEL needs OPENROUTER_API_KEY" 2 ;;
  openai) [ -n "${OPENAI_API_KEY:-}" ] || die "AGENT_MODEL=$AGENT_MODEL needs OPENAI_API_KEY" 2 ;;
  *) die "AGENT_MODEL=$AGENT_MODEL: use a google-genai:, anthropic:, openrouter: or openai: model" 2 ;;
esac

DIR="${FOUNDEROS_DIR:-/opt/founderos}"
DATA="${FOUNDEROS_DATA_DIR:-${DIR}-data}"
BRANCH="${DEPLOY_BRANCH:-main}"
REPO_URL="${FOUNDEROS_REPO_URL:-$(git -C "$SELF_REPO" remote get-url origin 2>/dev/null || echo https://github.com/pushkarverma3698/FounderOS.git)}"
for p in "$DIR" "$DATA"; do
  case "$p" in /*[!A-Za-z0-9._/-]*|/|"") die "path '$p' must be absolute and use only letters, digits, . _ - /" 2 ;; /*) ;; *) die "path '$p' must be absolute" 2 ;; esac
done

if [ "$MODE" = "check" ]; then
  echo "install.sh: inputs OK (model $AGENT_MODEL, app $DIR, data $DATA, branch $BRANCH)"
  exit 0
fi

[ "$(id -u)" = "0" ] || die "run as root: sudo -E ./deploy/install.sh" 1
HAVE_SYSTEMD=0
[ -d /run/systemd/system ] && HAVE_SYSTEMD=1
WARNINGS=()

# --- 2. host packages ------------------------------------------------------------------------------
# Postgres (with pgvector) and Ollama run as the two containers in deploy/stack.compose.yml, exactly as
# on the founder's box, so what gets installed here is Docker and its compose plugin.
log "Host packages"
export DEBIAN_FRONTEND=noninteractive
need=()
for p in ca-certificates curl git gnupg jq ffmpeg openssl sudo docker.io docker-compose-v2; do
  dpkg -s "$p" >/dev/null 2>&1 || need+=("$p")
done
if [ "${#need[@]}" -gt 0 ]; then
  note "apt: ${need[*]}"
  apt-get update -qq
  apt-get install -y -qq "${need[@]}"
fi

add_apt_repo() { # name key-url deb-line
  install -d -m 0755 /etc/apt/keyrings
  if [ ! -s "/etc/apt/keyrings/$1.gpg" ]; then
    curl -fsSL "$2" | gpg --dearmor -o "/etc/apt/keyrings/$1.gpg"
    chmod 0644 "/etc/apt/keyrings/$1.gpg"
  fi
  printf '%s\n' "$3" > "/etc/apt/sources.list.d/$1.list"
  apt-get update -qq
}
ARCH="$(dpkg --print-architecture)"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  note "Node 22 (NodeSource)"
  add_apt_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    "deb [arch=$ARCH signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main"
  apt-get install -y -qq nodejs
fi
if ! command -v gh >/dev/null 2>&1; then
  note "GitHub CLI"
  add_apt_repo github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    "deb [arch=$ARCH signed-by=/etc/apt/keyrings/github-cli.gpg] https://cli.github.com/packages stable main"
  apt-get install -y -qq gh
fi
command -v pnpm >/dev/null 2>&1 || { note "pnpm 9"; npm install -g pnpm@9 >/dev/null; }
if [ "$HAVE_SYSTEMD" = 1 ]; then systemctl enable --now docker >/dev/null 2>&1 || WARNINGS+=("could not enable the docker service"); fi

# --- 3. user, directories, checkout ------------------------------------------------------------------
log "Service user and directories"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA"

# git refuses a tree owned by another user; trust this one for this run only (nothing written to any gitconfig).
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$DIR"

log "Checkout $DIR ($BRANCH)"
if [ ! -d "$DIR/.git" ]; then
  if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then die "$DIR exists, is not empty and is not a git checkout; choose another FOUNDEROS_DIR"; fi
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
else
  note "already a checkout; deploy.sh fetches $BRANCH"
fi

# --- 4. .env -----------------------------------------------------------------------------------------
# Written once. An existing .env is yours and is never rewritten, so a re-run cannot change a secret.
if [ -f "$DIR/.env" ]; then
  log ".env exists: left as it is"
  DB_PASS="$(grep -E '^DATABASE_URL=' "$DIR/.env" | head -1 | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|' || true)"
else
  log "Writing $DIR/.env (mode 600)"
  DB_PASS="$(openssl rand -hex 24)"
  (
    umask 077
    {
      echo "# Written by deploy/install.sh. Every variable the app reads is described in .env.example."
      echo "DATABASE_URL=postgresql://founderos:${DB_PASS}@127.0.0.1:5432/founderos"
      echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}"
      echo "TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}"
      echo "GITHUB_TOKEN=${GITHUB_TOKEN}"
      echo "AGENT_MODEL=${AGENT_MODEL}"
      [ -z "${GOOGLE_GENERATIVE_AI_API_KEY:-}" ] || echo "GOOGLE_GENERATIVE_AI_API_KEY=${GOOGLE_GENERATIVE_AI_API_KEY}"
      [ -z "${ANTHROPIC_API_KEY:-}" ] || echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
      [ -z "${OPENROUTER_API_KEY:-}" ] || echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}"
      [ -z "${OPENAI_API_KEY:-}" ] || echo "OPENAI_API_KEY=${OPENAI_API_KEY}"
      echo "FOUNDEROS_DATA_ROOT=${DATA}"
      echo "# Keep deploy.sh from writing the repo owner's profile into your database."
      echo "FOUNDEROS_SKIP_FOUNDER_SEED=1"
    } > "$DIR/.env"
  )
fi
[ -n "$DB_PASS" ] || die "could not read the database password from $DIR/.env (DATABASE_URL)"
chown "$SERVICE_USER:$SERVICE_USER" "$DIR/.env"
chmod 600 "$DIR/.env"

# --- 5. systemd unit ---------------------------------------------------------------------------------
# deploy/founderos.service names /opt/founderos; render it for the chosen paths and install it only when it differs.
log "systemd unit"
UNIT=/etc/systemd/system/founderos.service
tmp_unit="$(mktemp)"
sed -e "s|/opt/founderos-data|@DATA@|g" -e "s|/opt/founderos|${DIR}|g" -e "s|@DATA@|${DATA}|g" "$DIR/deploy/founderos.service" > "$tmp_unit"
if cmp -s "$tmp_unit" "$UNIT" 2>/dev/null; then
  note "unchanged"
else
  install -m 0644 "$tmp_unit" "$UNIT"
  note "installed $UNIT"
  [ "$HAVE_SYSTEMD" = 0 ] || systemctl daemon-reload
fi
rm -f "$tmp_unit"
if [ "$HAVE_SYSTEMD" = 1 ]; then systemctl enable founderos >/dev/null 2>&1; else note "no systemd here: unit written, not enabled"; fi

if [ "$MODE" = "prepare" ]; then
  echo "install.sh: --prepare-only done. Next: sudo -E ./deploy/install.sh (without the flag)."
  exit 0
fi

# --- 6. deploy ---------------------------------------------------------------------------------------
service_active() { [ "$HAVE_SYSTEMD" = 1 ] && [ "$(systemctl is-active founderos 2>/dev/null || true)" = "active" ]; }
local_head="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
remote_head="$(git -C "$DIR" ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1 || true)"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DIR" "$DATA"
if service_active && [ -n "$local_head" ] && [ "$local_head" = "$remote_head" ] && curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1; then
  log "Already running $BRANCH at ${local_head:0:8}: nothing to deploy"
else
  log "deploy/deploy.sh (build, migrate, restart, health)"
  (
    cd "$DIR"
    APP_DIR="$DIR" DEPLOY_BRANCH="$BRANCH" FOUNDEROS_SKIP_FOUNDER_SEED=1 POSTGRES_PASSWORD="$DB_PASS" bash deploy/deploy.sh
  ) || die "deploy.sh failed; its output above names the step. Fix it and re-run this script."
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DIR" "$DATA"
fi

# --- 7. daemons (optional: only the coding pipeline needs them) ----------------------------------------
# sync-daemons.sh installs the dispatch daemons and the job/login sockets. Its units run as the users
# founderos and antigravity (the unprivileged user that runs the agy CLI), so both must exist. Failure here
# is reported but does not undo the bot: the core install is already healthy.
log "Daemons (deploy/sync-daemons.sh)"
id antigravity >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin antigravity
if [ "$HAVE_SYSTEMD" = 1 ]; then
  if HOME="$SERVICE_HOME" SYNC_DAEMONS_DEST="$SERVICE_HOME/bin" SYNC_DAEMONS_UNIT_DEST=/etc/systemd/system SYNC_DAEMONS_SUDO= \
      bash "$DIR/deploy/sync-daemons.sh"; then
    chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME/bin"
  else
    WARNINGS+=("deploy/sync-daemons.sh failed: the coding pipeline (/task, agent PRs) is not set up; the bot itself is unaffected")
  fi
else
  note "no systemd here: skipped"
fi

# --- 8. verify ---------------------------------------------------------------------------------------
log "Verify"
service_active || die "founderos is not active: journalctl -u founderos -n 50"
curl -fsS http://127.0.0.1:3001/health >/dev/null || die "http://127.0.0.1:3001/health did not answer: journalctl -u founderos -n 50"
note "systemctl is-active founderos: active; /health: ok"
for w in "${WARNINGS[@]+"${WARNINGS[@]}"}"; do printf 'WARNING: %s\n' "$w" >&2; done
echo "install.sh: done. In Telegram, send your bot /where, then a plain question. See docs/SELF-HOST.md (Verify)."
