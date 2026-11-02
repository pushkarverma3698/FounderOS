#!/usr/bin/env bash
# Fake crontab: the table lives in $FAKE/crontab.
set -euo pipefail
case "${1:-}" in
  -l) [[ -f $FAKE/crontab ]] || { echo "no crontab for test" >&2; exit 1; }; cat "$FAKE/crontab" ;;
  -) cat > "$FAKE/crontab" ;;
esac
