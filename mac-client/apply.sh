#!/usr/bin/env bash
#
# One-click launcher for the Mac apply queue — pick a candidate, sync, apply.
#
# WHY THE `set -e` AND THE EXISTENCE CHECK. Until 2026-09-15 option 2 copied
# `apply-profile-wife.example.json` — the shipped template whose first_name,
# last_name, email and phone are all the literal string "REPLACE" — over
# `apply-profile.json`, because no real profile for her had ever been written.
# `load_profile` only checked that fields were non-empty, so it accepted them,
# and the browser queue would have typed REPLACE into a real employer's form.
#
# Two changes close that: profile.py now refuses a placeholder value outright
# (PLACEHOLDER_VALUES), and this script refuses to copy an example file at all.
# An absent profile is now a loud stop with the fix printed, not a silent
# substitution — the same rule the rest of this client is built on.

set -euo pipefail
cd "$(dirname "$0")"

echo "Who are you applying for?"
echo "  1) Pushkar  (pushkar-nl-tech)"
echo "  2) Tashi    (wife-nl-finance)"
read -r -p "Select [1/2]: " choice

case "$choice" in
  1) source_profile="apply-profile-pushkar.json" ;;
  2) source_profile="apply-profile-wife.json" ;;
  *) echo "Invalid choice. Exiting."; exit 1 ;;
esac

if [ ! -f "$source_profile" ]; then
  echo "✗ $source_profile does not exist."
  echo
  echo "  Copy the matching example and fill in the real details:"
  echo "    cp ${source_profile%.json}.example.json $source_profile"
  echo
  echo "  Every REPLACE must be replaced — the queue refuses to start otherwise,"
  echo "  because those values would be typed into a real employer's form."
  exit 1
fi

case "$source_profile" in
  *.example.json)
    # Unreachable by the cases above, and kept as the belt to their braces: the
    # one thing this script must never do is hand the queue a template.
    echo "✗ Refusing to run from an example file. Fill in a real profile first."
    exit 1
    ;;
esac

echo "→ Using $source_profile"
cp "$source_profile" apply-profile.json

echo "→ Syncing queue from the VPS…"
.venv/bin/python -m mac_client.wake

echo "→ Launching the application queue…"
.venv/bin/python -m mac_client.apply
