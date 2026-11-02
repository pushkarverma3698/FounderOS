#!/usr/bin/env bash
# Fake docker for setup-dots.sh: every computer is running and every exec succeeds. Logs its arguments.
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE/docker.log"
case "${1:-}" in
  inspect) echo true ;;
  exec)
    # The brain MCP step passes the hub token on stdin; keep it apart so a test can check it never reaches an argument.
    if [[ " $* " == *" -i "* ]]; then
      if [[ "$*" == *HUB_URL=* ]]; then cat >> "$FAKE/hub-stdin.log"; else cat > /dev/null; fi
    fi
    exit 0 ;;
esac
