# 2026-10-12: OpenDots team works in every repo, with the Oplify rules kept local

## Outcome
The four OpenDots computers can work in 20 repos (the founder's account, OplifyMessage, turickai). The Oplify
instructions reach the Oplify clones without entering any git history. Prod is at `2e802158`.

## What shipped
- #1132 → beta: the employee setup (see `2026-10-12-opendots-employee-setup.md`).
- #1133 → beta: `TEAM_REPOS` defaults to 20 repos; the prompts no longer list repo names; local rules.
- #1134: both promoted to main with a merge commit. Deploy succeeded.

## Decisions
- Repo names are out of the prompts. 21 names put the Chief prompt 201 characters over its 2000-character cap, and
  `team-shift` and `chief-run` already read `/workspace/team-repos`.
- `pushkarverma3698/turicks-web` is not in the list: issues are off there, and that fails `team-shift --check` for
  every repo. `turickai/turicks-web` is the live copy.
- Local rules live on the VPS only, as `/opt/opendots/local-rules/<owner>.md`. `team-shift` writes them into that
  owner's clones as `CLAUDE.local.md`, `AGENTS.md` and `GEMINI.md`, each in `.git/info/exclude`. The Oplify repos
  track their own `CLAUDE.md`, so the copy uses `CLAUDE.local.md` and never touches the tracked file.
- Founder: no Slack or Telegram notifications; he uses the OpenDots app directly.

## Proof (live, 2026-10-12)
- All 4 computers: 20 lines in `/workspace/team-repos`, gh logged in, `WRITE` on `OplifyMessage/oplify-messaging-api`.
- The Chief, asked through `od-say` for the open PRs in the Oplify API repo, listed the same 8 numbers as
  `gh pr list` from the laptop.
- The Builder took a chat task on the Oplify API repo (issue 144 there). claude was at its session limit, so the
  09:30Z shift check restarted the run with agy, which opened draft PR 145 to beta: one file, +1 line.
- In that clone: the three rules files are 5813 bytes each and listed in `.git/info/exclude`, `git status` is
  clean, and the tracked `CLAUDE.md` is unchanged.
- The Reviewer picked PR 145 up at 09:45Z, hit the same claude limit, and agy took over at 10:01Z.

## Open
- With claude at its limit, each role loses up to 15 minutes before agy takes over: the takeover happens at the
  next shift check, not at once.
- The Architect has no agy login, so it stops while claude is at its limit.
- agy has no brain MCP.
- The computers still run the image from before this session; `team-shift` was copied into them with `docker cp`.
  The rebuilt image holds the same file and applies at their next restart.
- Gotcha: `install.sh` recreates `app-app-1`, so `/tmp/od-chat.mjs` must be copied back in before `od-say` works.
