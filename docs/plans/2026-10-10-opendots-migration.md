# OpenDots migration (2026-10-10)

Founder decision, 2026-10-10: retire FounderOS except the job pipeline. Run CopilotKit OpenDots on
founderos-vps as the chief of staff + specialist agents, reached from the phone. Agents get the
`claude` and `agy` CLIs. Jobs keep running as a standalone service with its own Telegram group, and
may move into an OpenDots agent later.

Decisions taken with the founder (AskUserQuestion, 2026-10-10):
- Platform: CopilotKit OpenDots (`github.com/CopilotKit/OpenDots`, pinned `625452e`).
- Jobs: keep standalone; strip this repo to the job pipeline.
- pr-brain and agent-dispatch: removed.
- Old code: archive, then strip. Archive tag `archive/founderos-v3` → `a7a0788e`.
- "openJev": no such project. OpenRouter's Jev Router is a model slug, not an install. Not used now;
  revisit only if OpenDots model spend shows up on the OpenRouter bill.

## Facts that shape the build
- OpenDots conversations need CopilotKit Intelligence. On a Linux VPS that means the hosted service
  (local Intelligence is a macOS Docker Desktop evaluation). Conversation history lives at CopilotKit;
  pages and Dot config live in SQLite on the VPS.
- No Telegram channel: phone access is the web app. Slack is the only chat channel it ships.
- A Dot's shell command is cut at 70 s (`computer-service.ts` `deadlineMs`). Long `claude -p` / `agy`
  runs go through `run-bg` (tmux, log under `/workspace/runs`).
- Each Dot computer is a Docker container capped at 2 GiB. The VPS has 7.6 GiB, no swap, and also runs
  Oplify's Postgres/Redis: keep at most two computers running.
- Only `/workspace` survives a computer restart, so `HOME=/workspace` keeps CLI logins (the computer service forces
  HOME=/workspace for every shell command anyway). Its root has no CAP_DAC_OVERRIDE: copied files must be uid 0.

## Phase 0: safety (done 2026-10-10)
- [x] `archive/founderos-v3` tag pushed.
- [x] DB backup `~/backups/founderos-20261010-062053.sql.gz` (77 MB) on the VPS.
- [x] Crons removed: pr-brain, agent-dispatch, journey-coding, journey-daily. Old crontab saved at
      `~/backups/crontab-pre-opendots-2026-10-10.txt`. Watchdog and nightly backup kept.

## Phase 1: OpenDots on the VPS
- [x] `/opt/opendots/app` at `625452e`, secrets generated in `.env` (mode 600).
- [x] Model: OpenRouter `typesafe/jev-router` (per-request model pick), same key as FounderOS. Switched 2026-10-10 on the founder's call.
- [x] `deploy/opendots/install.sh`: builds app, browser, supervisor, and `opendots-computer-turicks:1`
      (OpenBot + claude 2.1.287 + agy + gh + run-bg), starts on 127.0.0.1:4310. Ran clean 2026-10-10.
- [x] Tailscale 1.104.1 installed on the VPS; `tailscale up --hostname=turicks-dots` waits on the founder's login.
- [x] CopilotKit Intelligence key in `.env` (founder logged in 2026-10-10); setup reports nothing missing.
- [x] Tailscale: `https://turicks-dots.taile5afc3.ts.net` (tailnet only), `APP_ORIGIN` set.

## Phase 2: agents
- [x] Chief of Staff Dot: plans the day, writes "Task:" pages for the Engineer, no computer (`setup-dots.sh`). Live turn answered.
- [x] Engineer Dot: computer with shell; agy logged in and proven through a chat turn via `run-bg`.
- [ ] Engineer: `claude` login (founder's `claude setup-token`) and `gh auth` for PRs.
- [ ] One more specialist only after the first two are used daily (RAM limit above).

## Phase 3: jobs standalone (separate session)
The job pipeline's naive import closure is 439 of 592 files because it goes through gateway and
agent-tools hubs. It needs a new entry point, not a delete-around.
- [ ] New `src/jobs/main.ts`: scheduler jobs (sweep, brief, follow-up, findings) + jobs-group Telegram
      commands and callbacks only. No kernel, planner, or coding pipeline.
- [ ] Delete everything outside the new closure; update `verify-architecture.ts` and the baseline.
- [ ] Separate bot token for the jobs group (founder creates it in @BotFather).
- [ ] Deploy through PR → `main`; `founderos.service` runs the new entry; prove one brief lands in the group.

## Phase 4: VPS cleanup (after Phase 3 is live)
- [ ] Remove `~/bin/pr-brain`, `~/bin/agent-dispatch`, `agy-login.{socket,service}`, `/opt/review`,
      `/opt/agy-workspace`, `/opt/founderos-qa`, `/opt/founderos-tools` once nothing reads them.
- [ ] Drop DB tables the job pipeline does not use (after a fresh backup copied off the VPS).
- [ ] Stop `founderos-ollama` if nothing in the job pipeline embeds.
