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
#   deploy/job-run                  -> ~/bin/job-run       one /task = one process (started by fos-job.socket)
#   deploy/systemd/agy-login.*     -> /etc/systemd/system  (sudo -n; the socket the bot uses to sign agy in from Telegram)
#   deploy/systemd/fos-job.socket, fos-job@.service
#                                   -> /etc/systemd/system  (sudo -n; the socket the bot hands each coding job to)
#   (crontab)                       the old per-minute `agent-dispatch --kicked` line is REMOVED (see retire_kick_cron);
#                                   no other crontab line is touched
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
  "$SRC/job-run|$DEST/job-run|0755"
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
for name in agent-dispatch job-run pr-brain onboard-repo.sh; do
  out="$(PR_BRAIN_OWNER=sync-daemons-smoke "$DEST/$name" --help 2>&1 </dev/null)" \
    || fail "$DEST/$name --help exited non-zero, so it cannot start (a missing helper?): $(printf '%s' "$out" | tail -n1 | cut -c1-200)"
done

# 5. Retire the per-minute kick job. The bot used to leave a note that a cron line turned into a tick
# (`agent-dispatch --kicked`); it now hands the job to fos-job.socket instead and `--kicked` no longer exists, so a
# leftover line would fail every minute and log it. Only lines that run `agent-dispatch --kicked` are removed; the new
# crontab is read back and compared, and the old one is restored if any other line did not survive.
KICK_CRON_NOTE=""
retire_kick_cron() {
  local cron current wanted after line
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
  command -v "$cron" >/dev/null 2>&1 || return 0
  current="$("$cron" -l 2>/dev/null)" || current=""
  if ! grep -Eq '^[^#]*agent-dispatch[[:space:]]+--kicked' <<<"$current"; then
    KICK_CRON_NOTE="no kick cron to retire"
    return 0
  fi
  wanted="$(printf '%s\n' "$current" | grep -Ev '^[^#]*agent-dispatch[[:space:]]+--kicked')"
  if ! printf '%s\n' "$wanted" | "$cron" - 2>/dev/null; then
    fail "could not remove the kick job from the crontab"
  fi
  after="$("$cron" -l 2>/dev/null)" || after=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if ! grep -qxF -- "$line" <<<"$after"; then
      printf '%s\n' "$current" | "$cron" - 2>/dev/null
      fail "the crontab lost the line '$line' when the kick job was removed; the old crontab was restored"
    fi
  done <<<"$wanted"
  if grep -Eq '^[^#]*agent-dispatch[[:space:]]+--kicked' <<<"$after"; then
    printf '%s\n' "$current" | "$cron" - 2>/dev/null
    fail "the kick job is still in the crontab after it was removed; the old crontab was restored"
  fi
  KICK_CRON_NOTE="kick cron retired (jobs run through fos-job.socket now)"
}
retire_kick_cron
[[ -z "$KICK_CRON_NOTE" ]] || echo "sync-daemons: $KICK_CRON_NOTE"

# 6. The systemd units: the agy login helper and the job socket (fos-job.socket, deploy/systemd/fos-job.socket). `/login agy` from Telegram needs a process that runs as the `antigravity` user
# (the only one that can run agy) behind a unix socket the bot can open: the bot itself runs under NoNewPrivileges and
# cannot sudo (see deploy/systemd/agy-login.service and src/gateway/login/agy-helper.ts). Unit files live outside ~/bin and
# need root, so they are installed with `sudo -n` (the deploy user has passwordless sudo on the VPS), compared by sha256,
# and the socket is enabled. Without passwordless sudo this warns and does nothing, like the kick cron: /login agy then
# falls back to its by-hand instructions. The helper is try-restarted so it never serves last deploy's code.
# Env: SYNC_DAEMONS_UNIT_DEST (default /etc/systemd/system), SYNC_DAEMONS_SUDO (default `sudo -n`; empty = none),
#      SYNC_DAEMONS_SYSTEMCTL (default systemctl). Under a scratch HOME with none of these set it leaves systemd alone.
UNIT_NOTE=""
ensure_units() {
  local udest="${SYNC_DAEMONS_UNIT_DEST:-/etc/systemd/system}" sysctl="${SYNC_DAEMONS_SYSTEMCTL:-systemctl}"
  local -a sudo_cmd=()
  if [[ -n "${SYNC_DAEMONS_SUDO+x}" ]]; then
    read -r -a sudo_cmd <<<"${SYNC_DAEMONS_SUDO}"
    (( ${#sudo_cmd[@]} > 0 )) || sudo_cmd=(env) # no privilege wanted: `env` runs the command as is (bash 3.2 rejects an empty array under set -u)
  else
    sudo_cmd=(sudo -n)
  fi
  if [[ -z "${SYNC_DAEMONS_UNIT_DEST:-}" ]]; then
    local real_home
    real_home="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)"
    if [[ -z "$real_home" || "$HOME" != "$real_home" ]]; then
      UNIT_NOTE="systemd units left alone (HOME=$HOME is not this user's own home)"
      return 0
    fi
  fi
  local units=(agy-login.socket agy-login.service fos-job.socket fos-job@.service) u changed=0
  for u in "${units[@]}"; do
    [[ -s "$SRC/systemd/$u" ]] || fail "$SRC/systemd/$u is missing or empty in the checkout"
  done
  if ! command -v "$sysctl" >/dev/null 2>&1; then
    UNIT_NOTE="no systemctl here: the systemd units are not installed"
    return 0
  fi
  if ! "${sudo_cmd[@]}" true >/dev/null 2>&1; then
    UNIT_NOTE="WARNING: passwordless sudo is not available: the systemd units are not installed, so /task cannot start a run (the bot says so in the chat) and /login agy falls back to the by-hand steps"
    return 0
  fi
  for u in "${units[@]}"; do
    if [[ "$(sha256_of "$SRC/systemd/$u")" != "$(sha256_of "$udest/$u" 2>/dev/null)" ]]; then
      "${sudo_cmd[@]}" install -m 0644 "$SRC/systemd/$u" "$udest/$u.new" && "${sudo_cmd[@]}" mv -f "$udest/$u.new" "$udest/$u" \
        || fail "could not install $udest/$u"
      changed=1
    fi
  done
  for u in "${units[@]}"; do
    [[ "$(sha256_of "$SRC/systemd/$u")" == "$(sha256_of "$udest/$u" 2>/dev/null)" ]] \
      || fail "MISMATCH: $udest/$u differs from $SRC/systemd/$u after install"
  done
  if (( changed )); then
    "${sudo_cmd[@]}" "$sysctl" daemon-reload || fail "systemctl daemon-reload failed after installing the systemd units"
  fi
  local sock
  for sock in agy-login.socket fos-job.socket; do
    "${sudo_cmd[@]}" "$sysctl" enable --now "$sock" >/dev/null 2>&1 || fail "could not enable $sock"
    (( changed )) && { "${sudo_cmd[@]}" "$sysctl" restart "$sock" >/dev/null 2>&1 || fail "could not restart $sock"; }
  done
  # The login helper is try-restarted so it never serves last deploy's code. fos-job@ instances are NOT: a job that is
  # running finishes on the code it started with, and the next connection reads the new unit and script.
  "${sudo_cmd[@]}" "$sysctl" try-restart agy-login.service >/dev/null 2>&1 || true
  for sock in agy-login.socket fos-job.socket; do
    [[ "$("$sysctl" is-active "$sock" 2>/dev/null)" == "active" ]] || fail "$sock is not active after install"
  done
  UNIT_NOTE="systemd units installed; agy-login.socket and fos-job.socket active ($([[ $changed == 1 ]] && echo updated || echo unchanged))"
}
ensure_units
[[ -z "$UNIT_NOTE" ]] || echo "sync-daemons: $UNIT_NOTE"

echo "sync-daemons: $((${#PAIRS[@]})) files installed into $DEST ($LIB_COUNT libs first), every sha256 matches the checkout, every daemon starts"
