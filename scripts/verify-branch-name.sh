#!/usr/bin/env bash
# Verify the current branch follows docs/antigravity/BRANCHING-STRATEGY.md § Naming grammar.
#
# No-op on protected branches and on detached CI checkouts — it only ever fires on a work
# branch, which is the only place the name is still changeable (`git branch -m <new>`).
#
# Exit 0 = compliant or not applicable. Exit 1 = malformed name.
set -euo pipefail

TYPES='feat|fix|hotfix|chore|docs|refactor|test'
AGENTS='claude|cursor|antigravity'
MAX_LEN=60

# In GitHub Actions HEAD is detached; the PR's real branch is in GITHUB_HEAD_REF.
branch="${GITHUB_HEAD_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)}"

case "$branch" in
  main|beta|HEAD|'')
    echo "verify:branch — skipped (branch '$branch' is protected or detached)"
    exit 0
    ;;
esac

fail() {
  echo "verify:branch — FAIL: '$branch'"
  echo "  $1"
  echo
  echo "  Legal shapes (docs/antigravity/BRANCHING-STRATEGY.md § Naming grammar):"
  echo "    <type>/<slug>              type = $TYPES"
  echo "    <agent>/<type>-<slug>      agent = $AGENTS"
  echo "    task/issue-<N>-<slug>      VPS dispatcher only"
  echo
  echo "  Rename before pushing:  git branch -m fix/short-subject-slug"
  exit 1
}

if [ "${#branch}" -gt "$MAX_LEN" ]; then
  fail "name is ${#branch} chars; the limit is $MAX_LEN."
fi

if printf '%s' "$branch" | grep -qE '[^a-z0-9/-]'; then
  fail "only lowercase letters, digits, '-' and one '/' are allowed."
fi

if printf '%s' "$branch" | grep -qE "^task/issue-[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$"; then
  exec_ok=1
elif printf '%s' "$branch" | grep -qE "^($TYPES)/[a-z0-9]+(-[a-z0-9]+)+$"; then
  exec_ok=1
elif printf '%s' "$branch" | grep -qE "^($AGENTS)/($TYPES)-[a-z0-9]+(-[a-z0-9]+)+$"; then
  exec_ok=1
else
  exec_ok=0
fi

if [ "$exec_ok" -ne 1 ]; then
  case "$branch" in
    claude/*|cursor/*|antigravity/*)
      fail "agent-prefixed branches need a <type>- segment and a 2+ word subject slug (a harness codename like 'sweet-pike-6b0c3c' says nothing about the work)."
      ;;
    */*)
      fail "prefix is not a known type or agent, or the slug is a single word."
      ;;
    *)
      fail "no '<prefix>/' segment at all."
      ;;
  esac
fi

echo "verify:branch — OK: '$branch'"
