# 2026-10-10 — OpenDots migration, Phases 0–1

## What we did
- Founder decision: retire FounderOS except the job pipeline; run CopilotKit OpenDots on founderos-vps as the
  chief of staff + agents, reached from the phone; agents get `claude` and `agy`. Plan:
  `docs/plans/2026-10-10-opendots-migration.md`.
- Archive tag `archive/founderos-v3` → `a7a0788e`; DB backup `~/backups/founderos-20261010-062053.sql.gz` (77 MB).
- Crons removed: pr-brain, agent-dispatch, journey-coding, journey-daily (old crontab in `~/backups/`).
- OpenDots `625452e` running under `/opt/opendots/app` on 127.0.0.1:4310 via `deploy/opendots/install.sh`.
  The Dot computer image `opendots-computer-turicks:1` adds claude 2.1.287, agy 1.3.2, gh, tmux, and `run-bg`.
- Tailscale installed on the VPS, waiting on the founder's login.

## What we fixed
- A Dot's shell command is cut at 70 s: `run-bg` runs long `claude -p` / `agy` jobs in tmux with a log.
- The Dot's shell sources no profile, so the image wraps `claude` to read `/workspace/home/.claude-token`.
- The VPS has no claude login to copy (`~/.claude/.credentials.json` and `pr-brain.token` both absent), so the seed
  script takes a pasted `claude setup-token` token.

## Why
- "openJev" does not exist. OpenRouter's Jev Router is a model slug; skipped until model spend shows on the bill.
- Phone access goes over Tailscale, not a public port, because a Dot computer has a root shell.

## Metrics
- Job pipeline import closure: 439 of 592 src files. Phase 3 needs a new entry point, not a delete-around.

## Outstanding
- Founder: Tailscale login, CopilotKit Intelligence key, `claude setup-token`, jobs bot token.
- Then: `tailscale serve`, APP_ORIGIN, create the Chief of Staff + Engineer Dots, seed logins, one live chat turn.
- Phase 3 (jobs standalone) and Phase 4 (VPS cleanup) in separate sessions.
