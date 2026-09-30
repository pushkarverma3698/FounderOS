#!/usr/bin/env bash
#
# harden-agent-users — take GitHub write access, sudo and prod secrets away from the coding agents.
#
# WHY. The agents run as unprivileged users, but until 2026-09-30:
#   · `antigravity` (Antigravity/agy, started with --dangerously-skip-permissions on employer code)
#     held the founder's full-scope GitHub token (delete_repo, admin:org, workflow) in
#     ~/.config/gh/hosts.yml, plus a git credential helper that served it. A confused or
#     prompt-injected builder could push, delete or re-configure anything that token reaches.
#   · Its brain-MCP env file (~/.config/founderos-hub.env) held the production Telegram BOT TOKEN,
#     copied there only to satisfy an env validator the brain server never uses. With it the builder
#     could message the founder as the bot or break the bot's polling (409 conflict).
#   · Claude Code ran as `founderos`: passwordless sudo, and it reads /opt/founderos/.env.
#   · /opt/founderos-data (both CV sets, apply profiles) and a `.env` in the Oplify API review
#     checkout were world-readable, so the builder could read them. Files the bot creates are
#     0664 (umask 002), so this recurs; --check is what catches it next time.
# The design (docs/plans/2026-09-30-coding-pipeline-v2.md): agents PROPOSE (a spec, a patch, a
# verdict); only the orchestrator (founderos: agent-dispatch, pr-brain, the bot) pushes, labels,
# comments and merges. This makes that a fact the operating system enforces, not a prompt promise.
#
# --apply (root, idempotent; the important work first, and it always ends by running --check):
#   1. creates `claude-agent`: no sudo, no supplementary groups, locked password, home 0700
#   2. for antigravity and claude-agent: deletes the gh login, git credential helpers and stored
#      credentials, and rewrites every github.com push URL to an unresolvable host, so `git push`
#      fails even inside a repository whose remote points at GitHub (fetches are untouched)
#   3. replaces the Telegram bot token and chat id in the agents' *.env files with placeholders
#      (the brain MCP only needs them to be non-empty, verified 2026-09-30)
#   4. removes world access from /opt/founderos-data and from `.env` files in /opt/review
#   5. installs /etc/sudoers.d/claude-agent — the orchestrator may run the claude binary as
#      claude-agent and nothing else — validated with visudo before it goes live
# It never deletes an SSH private key or a database URL (a key may be someone's deploy key; the
# brain role `brain_agent` is deliberate): --check reports them and a human decides.
#
# --check (read-only): one ✓/✗ line per property, exit 1 if any ✗. It is the proof, and it is safe
# to run any time (after a deploy, after an OS upgrade). It prints variable and file NAMES, never
# values.
#
# Usage:  sudo bash deploy/harden-agent-users.sh --check
#         sudo bash deploy/harden-agent-users.sh --apply

set -uo pipefail

MODE=""
case "${1:-}" in
  --check) MODE=check ;;
  --apply) MODE=apply ;;
  -h|--help) sed -n '3,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "usage: sudo bash $0 --check | --apply" >&2; exit 2 ;;
esac

# Overridable so the tests can run against a scratch tree; on the VPS these are the defaults.
HOMES="${HARDEN_HOMES:-/home}"
SUDOERS_DIR="${HARDEN_SUDOERS_DIR:-/etc/sudoers.d}"
SUDOERS_OWNER="${HARDEN_SUDOERS_OWNER:-root}"
SUDOERS_GROUP="${HARDEN_SUDOERS_GROUP:-root}"
CLAUDE_BIN="${HARDEN_CLAUDE_BIN:-/usr/bin/claude}"
ENV_FILE="${HARDEN_ENV_FILE:-/opt/founderos/.env}"
DATA_DIR="${HARDEN_DATA_DIR:-/opt/founderos-data}"
REVIEW_DIR="${HARDEN_REVIEW_DIR:-/opt/review}"
ORCHESTRATOR="${HARDEN_ORCHESTRATOR:-founderos}"

AGENTS=(antigravity claude-agent)
PUSH_BASE="https://push-disabled.invalid/"
PUSH_FROM=("https://github.com/" "git@github.com:" "ssh://git@github.com/")
RULE="$ORCHESTRATOR ALL=(claude-agent) NOPASSWD: $CLAUDE_BIN"
# The one database role an agent may hold (SELECT/INSERT/UPDATE on brain.brain_memories only).
BRAIN_ROLE="brain_agent"
TOKEN_PLACEHOLDER="placeholder-unused"
# Secrets an agent's env file must never carry, whatever else it holds.
SECRET_VARS='ANTHROPIC_API_KEY|OPENAI_API_KEY|GOOGLE_GENERATIVE_AI_API_KEY|AWS_SECRET_ACCESS_KEY|RAZORPAY_KEY_SECRET|STRIPE_SECRET_KEY|GH_TOKEN|GITHUB_TOKEN'

# HARDEN_SKIP_ROOT_CHECK exists for the tests, which run against a scratch tree as an ordinary user;
# it only silences this message, the commands below still need root to do anything on a real host.
if [[ "${HARDEN_SKIP_ROOT_CHECK:-0}" != 1 && "$(id -u)" -ne 0 ]]; then
  echo "harden-agent-users: must run as root (sudo bash $0 $1)" >&2
  exit 2
fi

# as USER CMD… — CMD as USER, with USER's HOME and a scrubbed environment.
as() { local u="$1"; shift; sudo -n -u "$u" -H -- "$@"; }

fails=0
ok()  { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; fails=$((fails + 1)); }
# expect_ok DESC CMD…    ✓ when CMD succeeds
# expect_fail DESC CMD…  ✓ when CMD fails
# expect_empty DESC CMD… ✓ when CMD prints nothing (its exit status does not matter)
expect_ok()    { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
expect_fail()  { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }
expect_empty() {
  local d="$1" out total; shift
  out=$("$@" 2>/dev/null)
  if [[ -z "$out" ]]; then ok "$d"; return 0; fi
  # One finding per line, never cut mid-path: a truncated report hides the second problem.
  bad "$d — found:"
  printf '%s\n' "$out" | head -10 | sed 's/^/      /'
  total=$(printf '%s\n' "$out" | wc -l | tr -d ' ')
  if [[ "$total" -gt 10 ]]; then printf '      … and %s more\n' "$((total - 10))"; fi
}

# Octal mode, GNU stat first and BSD stat second.
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null; }

# The env-style files an agent could read secrets from: *.env and .env* under its home, three
# levels deep, skipping caches and package stores (which hold token-shaped test strings).
agent_env_files() {
  find "$1" -maxdepth 3 \( -path '*/.cache' -o -path '*/.npm' -o -path '*/.local' -o -path '*/node_modules' \) -prune \
       -o -type f \( -name '*.env' -o -name '.env' -o -name '.env.*' \) -print 2>/dev/null
}

# Env files in the review checkouts that others can read. A checkout is a few directories deep at
# most (packages/api/.env); node_modules holds test fixtures, not secrets.
world_readable_review_env() {
  find "$REVIEW_DIR" -maxdepth 4 -name node_modules -prune \
       -o -type f \( -name .env -o -name .env.local -o -name .env.production -o -name .env.staging \) -perm -o+r -print 2>/dev/null
}

# ------------------------------------------------------------------------- probes (names only)

# The NAMES of GitHub-token variables a login shell of USER would export (never their values).
login_env_tokens() {
  as "$1" bash -lc env | grep -E '^(GH_TOKEN|GITHUB_TOKEN|GITHUB_PAT|GH_ENTERPRISE_TOKEN)=' | cut -d= -f1
}

# Env files under USER's home that carry a real Telegram bot token (anything but the placeholder).
files_with_bot_token() {
  local f
  agent_env_files "$1" | while IFS= read -r f; do
    grep -E '^TELEGRAM_BOT_TOKEN=' "$f" 2>/dev/null | grep -qvE "=${TOKEN_PLACEHOLDER}\$" && echo "$f"
  done
}

# Env files that hold a DATABASE_URL for any role other than the brain role, or another secret.
files_with_other_secrets() {
  local f
  agent_env_files "$1" | while IFS= read -r f; do
    if grep -E '^DATABASE_URL=' "$f" 2>/dev/null | sed -E 's#^DATABASE_URL=[A-Za-z0-9+]+://([^:@/]+).*#\1#' | grep -qvx "$BRAIN_ROLE"; then
      echo "$f (DATABASE_URL for a role other than $BRAIN_ROLE)"
    fi
    grep -qE "^(${SECRET_VARS})=." "$f" 2>/dev/null && echo "$f (holds a secret variable: $(grep -oE "^(${SECRET_VARS})=" "$f" | tr -d '=' | tr '\n' ' '))"
  done
}

# ------------------------------------------------------------------------------------ checks

check_agent() {
  local u="$1" h="$HOMES/$1" from url f found=() groups g privileged=()
  printf '[%s]\n' "$u"
  expect_ok "account exists" id "$u"
  id "$u" >/dev/null 2>&1 || return 0   # nothing below means anything without the account

  # -- no GitHub authority
  expect_fail "gh holds no GitHub login" as "$u" env -u GH_TOKEN -u GITHUB_TOKEN gh auth status
  # All scopes (system, global): a helper in /etc/gitconfig would serve a token just as well.
  expect_empty "no git credential helper configured" as "$u" git config --get-regexp '^credential\.'
  for f in .config/gh/hosts.yml .git-credentials .config/git/credentials .netrc; do
    [[ -e "$h/$f" ]] && found+=("$f")
  done
  if [[ ${#found[@]} -eq 0 ]]; then ok "no stored GitHub credentials on disk"; else bad "stored credentials on disk: ${found[*]}"; fi
  # Anything in ~/.ssh that is not a public key, known_hosts, authorized_keys or config may be a key.
  expect_empty "no SSH private key" find "$h/.ssh" -maxdepth 1 -type f ! -name '*.pub' ! -name 'known_hosts*' ! -name authorized_keys ! -name config
  expect_empty "no GitHub token in the login environment" login_env_tokens "$u"
  for from in "${PUSH_FROM[@]}"; do
    url=$(as "$u" bash -c 'd=$(mktemp -d) && git init -q "$d" && git -C "$d" remote add origin "$1" \
                           && git -C "$d" remote get-url --push origin; [ -n "$d" ] && rm -rf -- "$d"' _ "${from}o/r.git" 2>/dev/null)
    if [[ "$url" == "$PUSH_BASE"* ]]; then ok "git push to ${from}… goes to an unresolvable host"
    else bad "git push to ${from}… would reach GitHub (push URL: ${url:-unknown})"; fi
  done

  # -- no production secrets
  expect_empty "no Telegram bot token in its env files" files_with_bot_token "$h"
  expect_empty "no other secret or database role in its env files" files_with_other_secrets "$h"
  expect_fail "cannot read $ENV_FILE" as "$u" test -r "$ENV_FILE"
  expect_fail "cannot read $DATA_DIR (CVs, apply profiles)" as "$u" test -r "$DATA_DIR"

  # -- no privilege
  expect_ok "sudo -l says it may run nothing" bash -c "sudo -n -l -U '$u' 2>&1 | grep -qi 'not allowed'"
  groups=" $(id -nG "$u") "
  for g in sudo admin wheel docker adm root lxd disk shadow "$ORCHESTRATOR"; do
    [[ "$groups" == *" $g "* ]] && privileged+=("$g")
  done
  if [[ ${#privileged[@]} -eq 0 ]]; then ok "in no privileged group"; else bad "member of privileged group(s): ${privileged[*]}"; fi
}

check_claude_agent() {
  printf '[claude-agent: account]\n'
  id claude-agent >/dev/null 2>&1 || return 0   # already reported as missing under [claude-agent]
  case "$(passwd -S claude-agent 2>/dev/null | awk '{print $2}')" in
    L|LK) ok "password is locked" ;;
    *) bad "password is not locked" ;;
  esac
  if [[ "$(mode_of "$HOMES/claude-agent")" == 700 ]]; then ok "home is 0700"; else bad "home is not 0700 (is $(mode_of "$HOMES/claude-agent"))"; fi
}

check_sudoers() {
  local f="$SUDOERS_DIR/claude-agent"
  printf '[sudoers]\n'
  if [[ ! -f "$f" ]]; then bad "$f is missing"; return 0; fi
  if grep -qxF "$RULE" "$f"; then ok "grants exactly: $RULE"; else bad "does not contain the expected rule: $RULE"; fi
  # Every rule line must be that one rule: nothing wider may ride along.
  if [[ "$(grep -vcE '^\s*(#|$)' "$f")" -eq 1 ]]; then ok "contains no other rule"; else bad "contains other rules"; fi
  if [[ "$(mode_of "$f")" == 440 ]]; then ok "mode 0440"; else bad "mode is $(mode_of "$f"), not 0440"; fi
  expect_ok "passes visudo -c" visudo -cf "$f"
}

check_secrets() {
  printf '[secrets on disk]\n'
  expect_empty "no world-readable .env under $REVIEW_DIR" world_readable_review_env
  if [[ -d "$DATA_DIR" && "$(mode_of "$DATA_DIR")" =~ [0-7][0-7][1-7]$ ]]; then
    bad "$DATA_DIR is open to others (mode $(mode_of "$DATA_DIR"))"
  else
    ok "$DATA_DIR is closed to others"
  fi
}

run_checks() {
  local u
  fails=0
  for u in "${AGENTS[@]}"; do check_agent "$u"; done
  check_claude_agent
  check_sudoers
  check_secrets
  echo
  if [[ "$fails" -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; fi
  [[ "$fails" -eq 0 ]]
}

# ------------------------------------------------------------------------------------- apply

strip_github_access() {
  local u="$1" h="$HOMES/$1" from
  rm -f "$h/.config/gh/hosts.yml" "$h/.git-credentials" "$h/.config/git/credentials" "$h/.netrc"
  # Each may be absent, which is fine: exit 5 / 128 from git config is not a failure here.
  as "$u" git config --global --remove-section 'credential.https://github.com' 2>/dev/null
  as "$u" git config --global --remove-section 'credential.https://gist.github.com' 2>/dev/null
  as "$u" git config --global --remove-section credential 2>/dev/null
  as "$u" git config --global --unset-all "url.${PUSH_BASE}.pushInsteadOf" 2>/dev/null
  for from in "${PUSH_FROM[@]}"; do
    as "$u" git config --global --add "url.${PUSH_BASE}.pushInsteadOf" "$from"
  done
  echo "  $u: GitHub login and credentials removed, push URLs disabled"
}

# Rewrite in place (cat > keeps the inode, owner and mode; no backup copy may keep the token).
neutralise_bot_token() {
  local u="$1" f tmp
  while IFS= read -r f; do
    grep -qE '^TELEGRAM_BOT_TOKEN=' "$f" || continue
    tmp=$(mktemp)
    sed -E "s#^TELEGRAM_BOT_TOKEN=.*#TELEGRAM_BOT_TOKEN=${TOKEN_PLACEHOLDER}#; s#^TELEGRAM_CHAT_ID=.*#TELEGRAM_CHAT_ID=0#" "$f" >"$tmp" \
      && cat "$tmp" >"$f"
    rm -f "$tmp"
    echo "  $u: Telegram bot token replaced with a placeholder in $f"
  done < <(agent_env_files "$HOMES/$u")
}

tighten_secrets() {
  local f
  if [[ -d "$DATA_DIR" ]]; then chmod o-rwx "$DATA_DIR" && echo "  closed $DATA_DIR to others"; fi
  while IFS= read -r f; do
    chmod o-rwx "$f" && echo "  closed $f to others"
  done < <(world_readable_review_env)
}

# Refuses (returns 1) rather than exiting: the rest of --apply has already run, and --check must
# still report what is missing.
install_sudoers() {
  local tmp; tmp=$(mktemp)
  {
    echo "# Managed by deploy/harden-agent-users.sh — edit there, not here."
    echo "# The orchestrator may run the Claude CLI as the unprivileged claude-agent user, and nothing else."
    echo "$RULE"
  } >"$tmp"
  if ! visudo -cf "$tmp" >/dev/null 2>&1; then
    echo "REFUSED: the generated sudoers rule failed visudo -c; nothing was installed" >&2
    rm -f "$tmp"
    return 1
  fi
  install -m 0440 -o "$SUDOERS_OWNER" -g "$SUDOERS_GROUP" "$tmp" "$SUDOERS_DIR/claude-agent"
  rm -f "$tmp"
  echo "  installed $SUDOERS_DIR/claude-agent"
}

apply() {
  local u
  echo "Hardening the agent users…"
  if ! id claude-agent >/dev/null 2>&1; then
    useradd --create-home --home-dir "$HOMES/claude-agent" --shell /bin/bash \
            --comment "FounderOS Claude agent (no sudo, no GitHub)" claude-agent \
      && echo "  created claude-agent"
  fi
  passwd -l claude-agent >/dev/null 2>&1
  chmod 700 "$HOMES/claude-agent"
  for u in "${AGENTS[@]}"; do strip_github_access "$u"; neutralise_bot_token "$u"; done
  tighten_secrets
  install_sudoers
  echo
}

if [[ "$MODE" == apply ]]; then apply; fi
run_checks
