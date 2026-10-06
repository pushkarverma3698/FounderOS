#!/bin/bash
# FounderOS: Mac capture into the VPS brain (AG-027). Run by launchd every 30 minutes.
# Capture on the Mac (no database, no LLM), pipe the digests over ssh to the VPS ingester.
# The next state file replaces the current one only after the VPS exited 0, so a failed run is retried whole.
# Env overrides (tests): BRAIN_CAPTURE_REPO, BRAIN_CAPTURE_STATE, BRAIN_CAPTURE_SSH, BRAIN_CAPTURE_REMOTE.
set -uo pipefail

REPO="${BRAIN_CAPTURE_REPO:-$HOME/Projects/founderos}"
STATE="${BRAIN_CAPTURE_STATE:-$HOME/.claude/brain-capture-state.json}"
SSH="${BRAIN_CAPTURE_SSH:-ssh}"
REMOTE="${BRAIN_CAPTURE_REMOTE:-founderos-vps}"
REMOTE_CMD='cd /opt/founderos && node --env-file=.env --import tsx/esm scripts/brain-ingest-digests.ts'

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$(dirname "$STATE")"

cd "$REPO" || { echo "brain-capture: cannot cd to $REPO" >&2; exit 1; }

if ! node --import tsx/esm scripts/brain-capture.ts --since-state --state "$STATE" --state-out "$TMP/next.json" > "$TMP/digests.jsonl" 2> "$TMP/capture.err"; then
  cat "$TMP/capture.err" >&2
  echo "brain-capture: capture failed, state unchanged" >&2
  exit 1
fi
cat "$TMP/capture.err" >&2

if [ ! -s "$TMP/digests.jsonl" ]; then
  mv "$TMP/next.json" "$STATE"
  echo "brain-capture: nothing new"
  exit 0
fi

if "$SSH" "$REMOTE" "$REMOTE_CMD" < "$TMP/digests.jsonl"; then
  mv "$TMP/next.json" "$STATE"
else
  echo "brain-capture: VPS ingest failed, state unchanged, next run retries" >&2
  exit 1
fi
