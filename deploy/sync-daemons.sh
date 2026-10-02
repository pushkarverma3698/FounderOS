#!/usr/bin/env bash
#
# sync-daemons.sh — copy the VPS daemons out of the app checkout into ~/bin and PROVE the copy.
#
# The daemons run from ~/bin/<name>, not from the checkout: until this existed a merge changed
# nothing on the box until somebody copied the files by hand, and nothing checked that anyone had
# (the deployed files matched the repo only by luck on 2026-09-29). The Deploy workflow runs this
# after the app is live and healthy, from /opt/founderos:    bash deploy/sync-daemons.sh
#
#   deploy/lib/*.sh                 -> ~/bin/lib/*.sh      sourced by the daemons: without them BOTH refuse to start
#   deploy/agent-dispatch           -> ~/bin/agent-dispatch
#   deploy/vps-daemons/pr-brain     -> ~/bin/pr-brain
#   deploy/onboard-repo.sh          -> ~/bin/onboard-repo.sh
#   (crontab)                       a `* * * * * … agent-dispatch --kicked` line, copied from the agent-dispatch
#                                   line already there (see ensure_kick_cron); no other crontab line is touched
#
# What it guarantees:
#   * nothing is copied unless every source exists and passes `bash -n` (a syntax error must not ship);
#   * every file is written to <name>.new, chmod'd, then mv'd into place: a daemon that starts
#     mid-sync sees the old file or the new one, never half of one, and (libs go first) never a new
#     daemon without its libs; a daemon that is RUNNING keeps its old inode and is not disturbed;
#   * afterwards every file's sha256 is compared with the checkout's, and each daemon is started
#     with --help from where it now lives, which proves it finds its helpers from its own real path;
#   * any mismatch or failure exits 1 and NAMES the file, so a red Deploy says which one.
#
# Rollback: check out the previous commit's deploy/ in /opt/founderos and run this again, or revert
# the merge and let the Deploy workflow re-sync.
#
# Env: SYNC_DAEMONS_DEST     where the daemons live (default $HOME/bin)
#      SYNC_DAEMONS_SRC      the deploy/ directory to copy from (default: the one this script is in)
#      SYNC_DAEMONS_CRONTAB  the crontab command to edit (default: `crontab`, and only when $HOME is this
#                            user's own home: a script run against a scratch HOME must never edit the real crontab)

set -uo pipefail

SELF="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SRC="${SYNC_DAEMONS_SRC:-$(cd "$(dirname "$SELF")" && pwd)}"
DEST="${SYNC_DAEMONS_DEST:-$HOME/bin}"

fail() {
  echo "sync-daemons: FAILED: $1" >&2
  exit 1
}

# GNU coreutils on the VPS; shasum where sha256sum does not exist (macOS).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# "<source>|<destination>|<mode>", libs first. The libs are sourced, not executed: 0644.
PAIRS=()
shopt -s nullglob
for f in "$SRC"/lib/*.sh; do
  PAIRS+=("$f|$DEST/lib/$(basename "$f")|0644")
done
shopt -u nullglob
LIB_COUNT="${#PAIRS[@]}"
[[ "$LIB_COUNT" -gt 0 ]] || fail "no lib/*.sh in $SRC — the daemons source their helpers from there and cannot start without them"
PAIRS+=(
  "$SRC/agent-dispatch|$DEST/agent-dispatch|0755"
  "$SRC/vps-daemons/pr-brain|$DEST/pr-brain|0755"
  "$SRC/onboard-repo.sh|$DEST/onboard-repo.sh|0755"
)

# 1. Pre-flight, before anything is touched.
for pair in "${PAIRS[@]}"; do
  IFS='|' read -r src _ _ <<<"$pair"
  [[ -s "$src" ]] || fail "$src is missing or empty in the checkout"
  bash -n "$src" 2>/dev/null || fail "$src does not pass bash -n: not shipping a syntax error to a daemon that runs unattended"
done

# 2. Install: write .new, set the mode, rename over the old file.
for pair in "${PAIRS[@]}"; do
  IFS='|' read -r src dst mode <<<"$pair"
  mkdir -p "$(dirname "$dst")" || fail "cannot create $(dirname "$dst")"
  if ! { cp "$src" "$dst.new" && chmod "$mode" "$dst.new" && mv -f "$dst.new" "$dst"; }; then
    rm -f "$dst.new"
    fail "could not install $dst"
  fi
done

# 3. Prove it: the deployed bytes are the checkout's bytes.
bad=0
for pair in "${PAIRS[@]}"; do
  IFS='|' read -r src dst mode <<<"$pair"
  want="$(sha256_of "$src")"
  got="$(sha256_of "$dst" 2>/dev/null)"
  if [[ "$want" != "$got" ]]; then
    echo "sync-daemons: MISMATCH: $dst differs from $src (checkout sha256 $want, deployed ${got:-unreadable})" >&2
    bad=1
  elif [[ "$mode" == "0755" && ! -x "$dst" ]]; then
    echo "sync-daemons: MISMATCH: $dst is not executable" >&2
    bad=1
  else
    printf 'sync-daemons: ok  %s  %s\n' "${want:0:12}" "$dst"
  fi
done
[[ "$bad" -eq 0 ]] || fail "the deployed daemons do not match the checkout (see MISMATCH above)"

# 4. Each daemon must START from where it now lives: --help exits before any work, and only
# after the daemon has found (or failed to find) the helpers it sources. PR_BRAIN_OWNER stops
# pr-brain asking GitHub who it is.
for name in agent-dispatch pr-brain onboard-repo.sh; do
  out="$(PR_BRAIN_OWNER=sync-daemons-smoke "$DEST/$name" --help 2>&1 </dev/null)" \
    || fail "$DEST/$name --help exited non-zero, so it cannot start (a missing helper?): $(printf '%s' "$out" | tail -n1 | cut -c1-200)"
done

# 5. The per-minute kick job. The bot cannot start agent-dispatch itself (it runs under systemd with
# NoNewPrivileges, where every sudo fails: src/tools/dispatch-tick.ts has the story), so it leaves a note and a
# cron job outside that sandbox turns the note into a tick: `agent-dispatch --kicked` every minute, silent and
# free unless a note is there. Without this line a merge would change nothing (the reason this script exists),
# so it is installed here, copied from the agent-dispatch line the crontab already has: same user, PATH and env
# file, only the schedule and the flag differ. Idempotent, and no other line is ever touched: the new crontab is
# read back and compared before this returns, and the old one is restored if it does not match.
KICK_CRON_NOTE=""
ensure_kick_cron() {
  local cron current base wanted after line
  if [[ -n "${SYNC_DAEMONS_CRONTAB:-}" ]]; then
    cron="$SYNC_DAEMONS_CRONTAB"
  else
    local real_home
    real_home="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)"
    if [[ -z "$real_home" || "$HOME" != "$real_home" ]]; then
      KICK_CRON_NOTE="kick cron left alone (HOME=$HOME is not this user's own home)"
      return 0
    fi
    cron=crontab
  fi
  if ! command -v "$cron" >/dev/null 2>&1; then
    KICK_CRON_NOTE="WARNING: no crontab command: the per-minute kick job is not installed (cron's 15-minute tick still works)"
    return 0
  fi
  current="$("$cron" -l 2>/dev/null)" || current=""
  if printf '%s\n' "$current" | grep -Eq '^[^#]*agent-dispatch[[:space:]]+--kicked'; then
    KICK_CRON_NOTE="kick cron already installed"
    return 0
  fi
  base="$(printf '%s\n' "$current" | grep -E '^[^#]*[/ ]agent-dispatch([[:space:]]|$)' | grep -v -e '--kicked' | head -n1)"
  if [[ -z "$base" ]]; then
    KICK_CRON_NOTE="WARNING: no agent-dispatch line in the crontab to copy the environment from: the per-minute kick job is not installed (cron's 15-minute tick still works)"
    return 0
  fi
  wanted="$(printf '%s\n' "$base" | sed -E 's#^[[:space:]]*([^[:space:]]+[[:space:]]+){5}#* * * * * #; s#(agent-dispatch)([[:space:]]|$)#\1 --kicked\2#')"
  if ! printf '%s\n%s\n' "$current" "$wanted" | "$cron" - 2>/dev/null; then
    fail "could not install the kick job into the crontab"
  fi
  after="$("$cron" -l 2>/dev/null)" || after=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if ! printf '%s\n' "$after" | grep -qxF -- "$line"; then
      printf '%s\n' "$current" | "$cron" - 2>/dev/null
      fail "the crontab does not hold the line '$line' after the kick job was added; the old crontab was restored"
    fi
  done < <(printf '%s\n%s\n' "$current" "$wanted")
  KICK_CRON_NOTE="kick cron installed: $wanted"
}
ensure_kick_cron
[[ -z "$KICK_CRON_NOTE" ]] || echo "sync-daemons: $KICK_CRON_NOTE"

echo "sync-daemons: $((${#PAIRS[@]})) files installed into $DEST ($LIB_COUNT libs first), every sha256 matches the checkout, every daemon starts"
