#!/usr/bin/env bash
# gh-token.sh — the bot's ONE GitHub token, for every gh and git call the daemons make.
#
# SOURCED by deploy/agent-dispatch, deploy/vps-daemons/pr-brain, deploy/job-run (and deploy/lib/agy-run.sh, which
# needs gh_shell_prelude). It needs nothing from them except `as_antigravity` for as_antigravity_gh.
#
# Why. The daemons used to ride on whatever `gh auth login` each Linux user had done: a second token per user, with
# its own scopes, expiry and repo reach, that nothing in the repo described. A repo the bot could open an issue on
# but the daemon's user could not read became a /task that filed an issue nothing would ever claim (AG-039). Now
# there is one token: GITHUB_TOKEN, the bot's, read from the env file the daemon already sources.
#
#   gh_token_load FILE      exports GH_TOKEN (gh uses it before any stored login) and adds a git credential helper
#                           that reads it, to the daemon's own process. Returns 1 when FILE has no GITHUB_TOKEN.
#   gh_shell_prelude        the text that opens every `sudo -u antigravity -- bash -lc` script that talks to GitHub:
#                           it reads the token from the first line of STDIN and does the same for that shell.
#   as_antigravity_gh S A…  as_antigravity, with the token piped to the prelude.
#
# The token travels in the environment of the process that needs it and, across sudo, on stdin. Never in argv (ps and
# the sudo log show argv), never in a URL (git prints URLs in errors), never in a file. sudo closes every descriptor
# above 2 and resets the environment, so stdin is the one channel that is guaranteed to arrive.

# The helper git runs for https://github.com: a shell snippet that prints the credentials git asks for. It names the
# variable, never the value, so the token is not in `git config`, `ps`, or GIT_TRACE output.
GH_GIT_CREDENTIAL_HELPER='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'

# The name every commit the bot makes carries, whoever's Linux account ran git. Without it a commit takes the user's
# own git config (a hostname address, or none) and nothing on GitHub says "an agent wrote this". Override with
# FOS_GIT_NAME / FOS_GIT_EMAIL in the env file's daemon (set the email to the bot account's noreply address once it has
# its own GitHub account, so its commits link to it).
FOS_GIT_NAME_DEFAULT="FounderOS Bot"
FOS_GIT_EMAIL_DEFAULT="founderos-bot@users.noreply.github.com"
fos_git_name() { printf '%s' "${FOS_GIT_NAME:-$FOS_GIT_NAME_DEFAULT}"; }
fos_git_email() { printf '%s' "${FOS_GIT_EMAIL:-$FOS_GIT_EMAIL_DEFAULT}"; }

# gh_token_value FILE -> the GITHUB_TOKEN line's value on stdout; status 1 when the file or the line is missing.
gh_token_value() {
  [[ -n "${1:-}" && -f "$1" ]] || return 1
  local t
  t="$(grep -m1 '^GITHUB_TOKEN=' "$1" | cut -d= -f2- | tr -d '"'"'"'\r')"
  [[ -n "$t" ]] || return 1
  printf '%s' "$t"
}

# gh_token_load FILE — see the header. Adds to GIT_CONFIG_COUNT rather than replacing it: the tests (and any caller)
# may already have configuration in it. The first entry is an EMPTY credential.helper, which makes git forget every
# helper it would otherwise ask first (a stored one is a second token again).
gh_token_load() {
  local t n
  t="$(gh_token_value "${1:-}")" || return 1
  export GH_TOKEN="$t"
  GIT_AUTHOR_NAME="$(fos_git_name)" GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
  GIT_AUTHOR_EMAIL="$(fos_git_email)" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
  export GIT_AUTHOR_NAME GIT_COMMITTER_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_EMAIL
  if [[ -z "${GH_TOKEN_GIT_HELPER:-}" ]]; then
    n="${GIT_CONFIG_COUNT:-0}"
    export "GIT_CONFIG_KEY_${n}=credential.helper" "GIT_CONFIG_VALUE_${n}="
    export "GIT_CONFIG_KEY_$((n + 1))=credential.helper" "GIT_CONFIG_VALUE_$((n + 1))=${GH_GIT_CREDENTIAL_HELPER}"
    export GIT_CONFIG_COUNT=$((n + 2))
    export GH_TOKEN_GIT_HELPER=1 # children (job-run starts agent-dispatch) must not add the pair a second time
  fi
  return 0
}

# gh_shell_prelude — prints the script text that goes in front of the real script of a sudo'd shell.
gh_shell_prelude() {
  printf '%s\n' 'IFS= read -r GH_TOKEN || true'
  printf '%s\n' 'if [ -n "$GH_TOKEN" ]; then'
  printf '%s\n' '  export GH_TOKEN'
  printf '%s\n' '  _n=${GIT_CONFIG_COUNT:-0}'
  printf '  _h=%q\n' "$GH_GIT_CREDENTIAL_HELPER"
  printf '%s\n' '  export "GIT_CONFIG_KEY_$_n=credential.helper" "GIT_CONFIG_VALUE_$_n="'
  printf '%s\n' '  export "GIT_CONFIG_KEY_$((_n + 1))=credential.helper" "GIT_CONFIG_VALUE_$((_n + 1))=$_h"'
  printf '%s\n' '  export GIT_CONFIG_COUNT=$((_n + 2))'
  printf '  export GIT_AUTHOR_NAME=%q GIT_COMMITTER_NAME=%q GIT_AUTHOR_EMAIL=%q GIT_COMMITTER_EMAIL=%q\n' \
    "$(fos_git_name)" "$(fos_git_name)" "$(fos_git_email)" "$(fos_git_email)"
  printf '%s\n' 'else'
  printf '%s\n' '  unset GH_TOKEN'
  printf '%s\n' 'fi'
}

# as_antigravity_gh SCRIPT [ARGS…] — as_antigravity for a script that fetches, pushes or calls gh. Its stdin is the
# token, so the script must not read stdin itself. (Scripts that do, agy_run and claude_run, put the token on the
# first line of their own stdin.)
as_antigravity_gh() {
  local script="$1"
  shift
  printf '%s\n' "${GH_TOKEN:-}" | as_antigravity "$(gh_shell_prelude)
${script}" "$@"
}
