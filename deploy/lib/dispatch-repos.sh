#!/usr/bin/env bash
# dispatch-repos.sh — the repositories the loop works on: DISPATCH_REPO_ALLOWLIST, printed by the TypeScript.
#
# SOURCED by deploy/agent-dispatch and deploy/onboard-repo.sh. There is no copy of the list in bash. The daemon once
# carried its own, held equal to the TypeScript list by a CI test; a repo added to one and not the other was a /task
# that filed an issue nothing would claim. Now `pnpm repo:add` edits the one list, and this file asks it.
#
#   dispatch_repos_print   one owner/repo per line, in the allowlist's order; status 1 and a reason on stderr when
#                          the printer cannot run or prints nothing.
#
# Env (tests): DISPATCH_REPOS_ROOT (default /opt/founderos: the deployed checkout), DISPATCH_REPOS_NODE (default node).

dispatch_repos_print() {
  local root="${DISPATCH_REPOS_ROOT:-/opt/founderos}" node="${DISPATCH_REPOS_NODE:-node}" out
  if ! out="$(cd "$root" 2>/dev/null && "$node" --import tsx/esm scripts/print-dispatch-repos.ts 2>&1)"; then
    printf 'cannot read the repo list: scripts/print-dispatch-repos.ts failed in %s (%s)\n' "$root" "$(printf '%s' "$out" | head -n1 | cut -c1-160)" >&2
    return 1
  fi
  if [[ -z "${out//[[:space:]]/}" ]]; then
    printf 'cannot read the repo list: scripts/print-dispatch-repos.ts printed nothing in %s\n' "$root" >&2
    return 1
  fi
  printf '%s\n' "$out"
}
