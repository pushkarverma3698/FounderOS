#!/usr/bin/env bash
# Fake docker for setup-dots.sh and shift-cron: every computer is running and every exec succeeds; `exec <box>
# team-shift <role> --check` prints $FAKE/check-<role> and exits with $FAKE/check-<role>.rc. Logs its arguments.
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE/docker.log"
case "${1:-}" in
  inspect) echo true ;;
  exec)
    if [[ ${3:-} == team-shift ]]; then cat "$FAKE/check-$4" 2>/dev/null || echo "No work"; exit "$(cat "$FAKE/check-$4.rc" 2>/dev/null || echo 0)"; fi
    [[ " $* " == *" -i "* ]] && cat > /dev/null; exit 0 ;;
esac
