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
# Env: SYNC_DAEMONS_DEST  where the daemons live (default $HOME/bin)
#      SYNC_DAEMONS_SRC   the deploy/ directory to copy from (default: the one this script is in)

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
for f in "$SRC"/lib/*.sh "$SRC"/lib/*.py; do
  [[ -f "$f" ]] && PAIRS+=("$f|$DEST/lib/$(basename "$f")|0644")
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
  if [[ "$src" == *.py ]]; then
    python3 -m py_compile "$src" 2>/dev/null || fail "$src does not compile with python3"
  else
    bash -n "$src" 2>/dev/null || fail "$src does not pass bash -n: not shipping a syntax error to a daemon that runs unattended"
  fi
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

echo "sync-daemons: $((${#PAIRS[@]})) files installed into $DEST ($LIB_COUNT libs first), every sha256 matches the checkout, every daemon starts"
