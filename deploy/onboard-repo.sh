#!/usr/bin/env bash
#
# onboard-repo.sh — put a repository on the agent loop, or report what it is missing.
#
#   onboard-repo.sh <owner/repo>               provision what is missing (idempotent), then print
#                                              a checklist of what it has just VERIFIED
#   onboard-repo.sh --check [owner/repo ...]   report what is missing and change NOTHING; with no
#                                              repos, checks DEFAULT_REPOS of the agent-dispatch
#                                              that sits next to this script (the daemon's list)
#   options:  --porcelain   one row per piece for scripts: repo<TAB>piece<TAB>status<TAB>detail
#
# A repo on the loop needs three things on the VPS, and each used to be a manual step nobody could
# verify (on 2026-09-23 a repo was allowlisted while the daemon had never heard of it):
#   review     <ONBOARD_REVIEW_BASE>/<name>                 pr-brain reviews the agent's PRs here
#   workspace  <AGENT_DISPATCH_WORKSPACE_BASE>/<name>       Antigravity works here, owned by AGENT_DISPATCH_USER
#   labels     the six agent:* labels on the GitHub repo    agent-dispatch moves an issue through them
# <name> is the repo's name, except that FounderOS lives in "founderos": the same rule the daemon uses.
#
# Statuses:  ok · MISSING (definitely absent or unusable) · WARN (there, but suspicious: its origin is a
#            different repo) · UNKNOWN (could not be checked, e.g. gh is down: never reported as missing).
# Exit: 0 every piece is ok · 1 something is not · 2 bad usage (nothing was run).
#
# Config (env):
#   ONBOARD_REVIEW_BASE             default /opt/review
#   AGENT_DISPATCH_WORKSPACE_BASE   default /opt/agy-workspace
#   AGENT_DISPATCH_USER             default antigravity (the Linux user that runs agy)
#
# Secrets: this script reads no token and prints none. Clones use the plain https URL through each
# user's own git credential helper, so no credential is ever on a command line, and any URL that
# has to be printed from an error has its credentials stripped first.

set -uo pipefail
# Byte-wise character classes: an accented letter must not pass for [A-Za-z].
export LC_ALL=C

REVIEW_BASE="${ONBOARD_REVIEW_BASE:-/opt/review}"
WORKSPACE_BASE="${AGENT_DISPATCH_WORKSPACE_BASE:-/opt/agy-workspace}"
AG_USER="${AGENT_DISPATCH_USER:-antigravity}"

# The six agent:* labels: the five states agent-dispatch moves an issue through, and the one it puts
# on an issue whose brief is incomplete. tests/unit/scripts/onboard-repo.test.ts fails when this list
# and the labels deploy/agent-dispatch uses differ.
LABELS=(agent:ready agent:working agent:review agent:failed agent:blocked agent:needs-brief)

label_color() {
  case "$1" in
    agent:ready) echo 0E8A16 ;;
    agent:working) echo 1D76DB ;;
    agent:review) echo 5319E7 ;;
    agent:failed) echo B60205 ;;
    agent:blocked) echo D93F0B ;;
    *) echo FBCA04 ;;
  esac
}
label_description() {
  case "$1" in
    agent:ready) echo "Ready for agent-dispatch to claim: an unattended Antigravity run starts" ;;
    agent:working) echo "Claimed: Antigravity is working on it" ;;
    agent:review) echo "A draft PR is open and pr-brain is reviewing it" ;;
    agent:failed) echo "agent-dispatch could not get a PR out of this issue" ;;
    agent:blocked) echo "Hit the re-dispatch limit: needs a human to re-open" ;;
    *) echo "The issue is not a complete brief; agent-dispatch will not claim it until it is" ;;
  esac
}

SELF_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || printf '%s' "${BASH_SOURCE[0]}")"
SELF_DIR="$(cd "$(dirname "$SELF_PATH")" 2>/dev/null && pwd)"

# The directory name agent-dispatch uses for a repo (its FounderOS special case included).
dir_name() {
  case "$1" in
    *FounderOS*) printf 'founderos' ;;
    *) printf '%s' "${1#*/}" ;;
  esac
}

# owner: 1-39 letters, digits, hyphens, not starting with a hyphen. name: letters, digits . _ -,
# 1-100 characters, not starting with a hyphen, and neither "." nor "..". Anything else is refused
# before a single command runs, so a name can never carry a shell fragment or an option.
valid_slug() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$ ]] || return 1
  [[ "${1#*/}" != "." && "${1#*/}" != ".." ]]
}

# Every privileged step is `sudo -n [-u user] -- command`: never a password prompt, and always the
# explicit "--" that the sudoers rule and the tests key on.
as_ag() { sudo -n -u "$AG_USER" -- "$@"; }
as_root() { sudo -n -- "$@"; }

# Strip credentials out of anything that may be printed: URL userinfo, and token-shaped strings.
scrub() {
  sed -E 's#(https?://)[^/@[:space:]]+@#\1#g; s/(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/[REDACTED]/g'
}
first_line() { scrub | head -n1 | cut -c1-200; }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# owner/repo out of a remote URL: https://[user[:pw]@]host/o/r(.git), ssh://git@host/o/r, git@host:o/r.
norm_origin() {
  local u="$1"
  u="${u%.git}"
  u="${u%/}"
  printf '%s' "$u" | sed -E 's#^[a-z+]+://([^/@]*@)?[^/]+/##; s#^[^@/]+@[^:]+:##' | scrub
}
origin_of() { git config --file "$1/.git/config" --get remote.origin.url 2>/dev/null; }

# Is $1 (a directory) there and empty? Tried as ourselves, then as the antigravity user, who may
# own a directory we cannot list.
dir_empty() {
  [[ -d "$1" ]] || return 1
  [[ -z "$(ls -A "$1" 2>/dev/null || as_ag ls -A "$1" 2>/dev/null)" ]]
}

ROWS=()
row() { ROWS+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"$4"); }

# ------------------------------------------------------------------------------------------- check
check_repo() {
  local slug="$1" name rdir wdir origin owner names rc l
  name="$(dir_name "$slug")"
  rdir="$REVIEW_BASE/$name"
  wdir="$WORKSPACE_BASE/$name"

  if [[ -d "$rdir/.git" ]]; then
    origin="$(origin_of "$rdir")"
    if [[ "$(lower "$(norm_origin "$origin")")" == "$(lower "$slug")" ]]; then
      row "$slug" review ok "$rdir"
    else
      row "$slug" review WARN "$rdir: its origin is $(norm_origin "$origin"), expected $slug"
    fi
  elif [[ -e "$rdir" ]]; then
    row "$slug" review MISSING "$rdir exists but is not a git checkout"
  else
    row "$slug" review MISSING "$rdir does not exist (pr-brain has nothing to review the PRs in)"
  fi

  if [[ -d "$wdir/.git" ]] || as_ag test -d "$wdir/.git" 2>/dev/null; then
    owner="$(stat -c %U "$wdir" 2>/dev/null || stat -f %Su "$wdir" 2>/dev/null)"
    origin="$(origin_of "$wdir")"
    if [[ -n "$owner" && "$owner" != "$AG_USER" ]]; then
      row "$slug" workspace MISSING "$wdir is owned by $owner, expected $AG_USER (agy could not write in it)"
    elif [[ -n "$origin" && "$(lower "$(norm_origin "$origin")")" != "$(lower "$slug")" ]]; then
      row "$slug" workspace WARN "$wdir: its origin is $(norm_origin "$origin"), expected $slug"
    else
      row "$slug" workspace ok "$wdir"
    fi
  elif [[ -e "$wdir" ]]; then
    row "$slug" workspace MISSING "$wdir exists but is not a git checkout"
  else
    row "$slug" workspace MISSING "$wdir does not exist (Antigravity has nowhere to work)"
  fi

  names="$(gh label list --repo "$slug" --limit 200 --json name --jq '.[].name' 2>&1)"
  rc=$?
  if [[ "$rc" -ne 0 ]]; then
    row "$slug" labels UNKNOWN "could not list the labels: $(printf '%s' "$names" | first_line)"
  else
    for l in "${LABELS[@]}"; do
      if printf '%s\n' "$names" | grep -qxF -- "$l"; then
        row "$slug" "label:$l" ok present
      else
        row "$slug" "label:$l" MISSING "the label $l does not exist in $slug"
      fi
    done
  fi
}

# ------------------------------------------------------------------------------------- provision
# Each step looks first and acts only when something is missing, so a second run changes nothing.
# An action that fails is recorded here; whether the piece IS fine is decided afterwards by
# check_repo, so the checklist reports what is true, not what was attempted.
PROBLEMS=()
problem() { PROBLEMS+=("$1"); }

provision_repo() {
  local slug="$1" name rdir wdir url out owner names l
  name="$(dir_name "$slug")"
  rdir="$REVIEW_BASE/$name"
  wdir="$WORKSPACE_BASE/$name"
  url="https://github.com/${slug}.git"

  # 1. review checkout, as the user running this script
  if [[ -d "$rdir/.git" ]]; then
    out="$(git -C "$rdir" fetch --quiet origin 2>&1)" || problem "review checkout: git fetch failed: $(printf '%s' "$out" | first_line)"
  elif [[ -e "$rdir" ]] && ! dir_empty "$rdir"; then
    problem "review checkout: $rdir exists but is not a git checkout — not touching it"
  else
    mkdir -p "$REVIEW_BASE" 2>/dev/null || { as_root mkdir -p "$REVIEW_BASE" && as_root chown "$(id -un):" "$REVIEW_BASE"; } 2>/dev/null
    out="$(git clone --quiet "$url" "$rdir" 2>&1)" || problem "review checkout: git clone failed: $(printf '%s' "$out" | first_line)"
  fi

  # 2. agy workspace, as the antigravity user (a clone owned by anyone else cannot be written to by agy)
  if [[ -d "$wdir/.git" ]] || as_ag test -d "$wdir/.git" 2>/dev/null; then
    owner="$(stat -c %U "$wdir" 2>/dev/null || stat -f %Su "$wdir" 2>/dev/null)"
    if [[ -n "$owner" && "$owner" != "$AG_USER" ]]; then
      as_root chown -R "$AG_USER:" "$wdir" 2>/dev/null || problem "agy workspace: could not hand $wdir to $AG_USER (owned by $owner)"
    fi
    out="$(as_ag git -C "$wdir" fetch --quiet origin 2>&1)" || problem "agy workspace: git fetch failed: $(printf '%s' "$out" | first_line)"
  elif [[ -e "$wdir" ]] && ! dir_empty "$wdir"; then
    problem "agy workspace: $wdir exists but is not a git checkout — not touching it"
  else
    if as_root mkdir -p "$wdir" && as_root chown "$AG_USER:" "$wdir"; then
      out="$(as_ag git clone --quiet "$url" "$wdir" 2>&1)" || problem "agy workspace: git clone (as $AG_USER) failed: $(printf '%s' "$out" | first_line)"
    else
      problem "agy workspace: could not create $wdir and hand it to $AG_USER"
    fi
  fi

  # 3. labels: only the missing ones, so a run that has nothing to do makes no API write at all
  if names="$(gh label list --repo "$slug" --limit 200 --json name --jq '.[].name' 2>&1)"; then
    for l in "${LABELS[@]}"; do
      printf '%s\n' "$names" | grep -qxF -- "$l" && continue
      out="$(gh label create "$l" --repo "$slug" --color "$(label_color "$l")" --description "$(label_description "$l")" --force 2>&1)" \
        || problem "labels: could not create $l: $(printf '%s' "$out" | first_line)"
    done
  else
    problem "labels: could not list them: $(printf '%s' "$names" | first_line)"
  fi
}

# -------------------------------------------------------------------------------------- rendering
render_human() {
  local slug="$1" r repo piece status detail ok_labels=0 missing_labels="" hint
  hint="$SELF_DIR/onboard-repo.sh $slug"
  printf '%s\n' "$slug"
  for r in ${ROWS[@]+"${ROWS[@]}"}; do
    IFS=$'\t' read -r repo piece status detail <<<"$r"
    [[ "$repo" == "$slug" ]] || continue
    case "$piece" in
      review) printf '  %-8s  %-16s  %s\n' "$status" "review checkout" "$detail" ;;
      workspace) printf '  %-8s  %-16s  %s\n' "$status" "agy workspace" "$detail" ;;
      labels) printf '  %-8s  %-16s  %s\n' "$status" "labels" "$detail" ;;
      label:*)
        if [[ "$status" == ok ]]; then ok_labels=$((ok_labels + 1)); else missing_labels+="${missing_labels:+, }${piece#label:}"; fi
        ;;
    esac
  done
  if [[ "$ok_labels" -gt 0 || -n "$missing_labels" ]]; then
    if [[ -z "$missing_labels" ]]; then
      printf '  %-8s  %-16s  %s\n' ok labels "${ok_labels} of ${#LABELS[@]} agent:* labels present"
    else
      printf '  %-8s  %-16s  %s\n' MISSING labels "${ok_labels} of ${#LABELS[@]} present; missing ${missing_labels}"
    fi
  fi
  for r in ${ROWS[@]+"${ROWS[@]}"}; do
    IFS=$'\t' read -r repo piece status detail <<<"$r"
    if [[ "$repo" == "$slug" && "$status" != ok && "$status" != UNKNOWN ]]; then
      printf '  Fix: %s\n' "$hint"
      break
    fi
  done
}

all_ok() {
  local r status
  for r in ${ROWS[@]+"${ROWS[@]}"}; do
    IFS=$'\t' read -r _ _ status _ <<<"$r"
    [[ "$status" == ok ]] || return 1
  done
  return 0
}

# ------------------------------------------------------------------------------------------- main
usage() {
  sed -n '3,30p' "$SELF_PATH" | sed 's/^# \{0,1\}//'
}

MODE=provision
PORCELAIN=0
REPOS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE=check; shift ;;
    --porcelain) PORCELAIN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*/*) REPOS+=("$1"); shift ;;
    -*) echo "onboard-repo: unknown option '$1' (try --help)" >&2; exit 2 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

if [[ "$MODE" == check && "${#REPOS[@]}" -eq 0 ]]; then
  if ! DEFAULTS="$(grep -m1 '^DEFAULT_REPOS=(' "$SELF_DIR/agent-dispatch" 2>/dev/null | grep -oE '"[^"]+"' | tr -d '"')" || [[ -z "$DEFAULTS" ]]; then
    echo "onboard-repo: no repos given and no DEFAULT_REPOS=( … ) found in $SELF_DIR/agent-dispatch" >&2
    exit 2
  fi
  while IFS= read -r r; do REPOS+=("$r"); done <<<"$DEFAULTS"
fi

if [[ "$MODE" == provision && "${#REPOS[@]}" -ne 1 ]]; then
  echo "onboard-repo: give exactly one owner/repo (or use --check). Try --help." >&2
  exit 2
fi

# Validate EVERY name before anything runs.
for r in ${REPOS[@]+"${REPOS[@]}"}; do
  valid_slug "$r" || {
    printf 'onboard-repo: %q is not a valid owner/repo (expected e.g. pushkarverma3698/FounderOS)\n' "$r" >&2
    exit 2
  }
done

if [[ "$MODE" == provision ]]; then
  provision_repo "${REPOS[0]}"
fi

for r in "${REPOS[@]}"; do
  check_repo "$r"
done

if [[ "$PORCELAIN" -eq 1 ]]; then
  printf '%s\n' ${ROWS[@]+"${ROWS[@]}"}
else
  if [[ "${#PROBLEMS[@]}" -gt 0 ]]; then
    printf 'What went wrong:\n'
    printf '  ! %s\n' "${PROBLEMS[@]}"
  fi
  [[ "$MODE" == provision ]] && printf 'Checklist, verified just now:\n'
  for r in "${REPOS[@]}"; do
    render_human "$r"
  done
fi

all_ok
