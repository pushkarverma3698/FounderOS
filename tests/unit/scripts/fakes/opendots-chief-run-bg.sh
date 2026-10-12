#!/usr/bin/env bash
# Fake run-bg for opendots-chief-run.test.ts. A run whose name ends in -agy reads $FAKE/agy-state and $FAKE/agy-log,
# any other run $FAKE/state and $FAKE/log. "start" records the name and the command (NUL-separated).
set -euo pipefail
cmd=$1; name=${2:-}
p=""; [[ $name == *-agy ]] && p=agy-
case "$cmd" in
  start) shift 2; printf '%s\n' "$name" >> "$FAKE/${p}started"; printf '%s\0' "$@" > "$FAKE/${p}argv" ;;
  status | wait) cat "$FAKE/${p}state" 2>/dev/null || echo unknown; tail -n 20 "$FAKE/${p}log" 2>/dev/null || true ;;
  tail) cat "$FAKE/${p}log" 2>/dev/null || true ;;
esac
