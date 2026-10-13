#!/usr/bin/env bash
# Fake docker for setup-dots.sh: every computer is running and every exec succeeds. Logs its arguments.
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE/docker.log"
case "${1:-}" in
  inspect) echo true ;;
  exec) [[ " $* " == *" -i "* ]] && cat > /dev/null; exit 0 ;;
esac
