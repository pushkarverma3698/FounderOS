#!/usr/bin/env bash
# Fake run-bg for opendots-team-shift.test.ts: "start" records its arguments NUL-separated; status/tail read files the test writes.
set -euo pipefail
cmd=$1; name=${2:-}
case "$cmd" in
  start) shift 2; printf '%s\n' "$name" > "$FAKE/started"; printf '%s\0' "$@" > "$FAKE/argv" ;;
  status) cat "$FAKE/state" 2>/dev/null || echo unknown ;;
  tail) cat "$FAKE/log" 2>/dev/null || true ;;
esac
