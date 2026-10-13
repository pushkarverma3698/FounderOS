# OpenDots on founderos-vps

CopilotKit OpenDots (pinned `625452e`) runs in Docker under `/opt/opendots/app`, on `127.0.0.1:4310`.
Five Dots work like employees: Chief of Staff, Architect, Builder, Reviewer, DevOps. Each has its own computer
(`opendots-computer-turicks:1`: the pinned OpenBot computer plus `claude`, `agy`, `gh`, git, Postgres, Redis,
Playwright, `run-bg`, `dot-login`, `dot-task`, `team-services`) and leads claude and agy there. Plan and decisions:
`docs/plans/2026-10-10-opendots-migration.md`.

Use what OpenDots already has before adding a script here: Spaces and pages, Specialist Dots, computers,
Connections (MCP with approval cards), scheduled tasks (recurring, pause, retry), Memory, Slack and calls. The
GitHub-label pipeline (`team-shift`, `chief-run`, `shift-cron`, `shift-notify`) re-built a scheduler and dispatcher
on top of those and was removed on 2026-10-13; CI fails if those files come back (`scripts/verify-architecture.ts`).

| File | Purpose |
|---|---|
| `install.sh` | Install or update: clone, apply the patch, secrets, build all images, start, health check |
| `opendots-turicks.patch` | Our OpenDots changes, below |
| `computer.Dockerfile` | Each Dot's computer image |
| `compose.turicks.yml` | Points the supervisor at that image |
| `setup-dots.sh` | Creates or updates the Dots: prompts, computer permissions, logins (copied from the Builder), helpers, `home/`, local rules, brain MCP. Idempotent |
| `home/` | Every computer's employee setup: `CLAUDE.md` (the laptop's engineering rules minus laptop-only lines) as `~/.claude/CLAUDE.md` and `~/.gemini/GEMINI.md`, and the skills `production-ready`, `pr-adversary`, `systematic-debugging`, `no-ai-slop` for claude and agy. Edit here, not in a computer |
| `run-bg` | Long commands past the 70 s shell limit: `run-bg start <name> claude -p "..."`, then `run-bg wait <name>` (up to 55 s; call it with `timeoutMs` 60000) until `exit=` |
| `dot-login` | Driven from chat: `dot-login <claude\|agy\|gh> start [email]` gives a sign-in link, `finish <code\|url>` installs the login, `logout`, `status` |
| `dot-task` | The app's scheduled tasks from a shell: `dot-task create "<prompt>" --interval <sec>`, `list`, `show`, `run`, `pause`, `cancel`. The app runs one task at a time, so a run queued from a Dot's turn starts after that turn; read its answer later with `show` |
| `team-services` | Real Postgres 16 (pgvector) and Redis inside a computer for tests, below |

## How a Dot works
Each Dot's own model (OpenRouter) is cheap; claude and agy (subscriptions) are the experts. A Dot does cheap reads
(`gh`, `git log`) itself, writes a brief to `/workspace/runs/<name>.md`, starts `run-bg start <name> claude -p
"$(cat ...)"`, waits with `run-bg wait`, checks one key claim, and reports with the command it ran or NOT VERIFIED.
Before anything new is built, the brief asks what already exists. The shared prompt parts are `TOOLS`, `LEAD` and
`TRUTH` in `setup-dots.sh`; role parts are `CHIEF`, `ARCHITECT`, `BUILDER`, `REVIEWER`, `DEVOPS`.

- **Chief of Staff:** the founder's front door; merges a PR he names once `gh pr checks` is green; keeps the
  Everyday "Chief of Staff" page; reads calendar and mail through the brain Connection.
- **Architect:** plans from claude reading the code, filed as GitHub issues.
- **Builder:** code changes; claude opens a draft PR to the integration branch.
- **Reviewer:** `pr-adversary` reviews with tests on real services; agy for a second opinion.
- **DevOps:** servers, uptime, recurring routines as scheduled tasks. Updated only if it exists.

No Dot sends the founder to another Dot. Recurring work is an OpenDots scheduled task (Tasks in the app, or
`dot-task create`); there is no host cron.

## Our OpenDots patch
Applied by `install.sh` after a clean checkout; it fails loudly if upstream code moved.
- A turn or task may last 15 min (upstream: 90 s).
- A turn may make 30 model calls (upstream: 5), enough to start claude and wait on it; a turn still asking for
  tools at that limit fails instead of ending as completed.
- A recurring task retries one interval after a failed or interrupted run (upstream: waits for Run), and sends the
  model only its own turn.
- A model reply may be 16,000 tokens (upstream: 2,200); a reply cut off at the limit fails the turn. OpenRouter
  reports a cut-off tool call as `finish_reason "tool_calls"`, so the patch also checks `native_finish_reason`, the
  whole budget used, and tool arguments that do not parse.
- The web app remembers the owner token in `localStorage` (upstream: `sessionStorage`).
- Computers run **privileged** (founder 2026-10-13): upstream drops every capability and sets `no-new-privileges`, so
  Postgres (`runuser`), package installs and services failed. The supervisor image build fails if upstream moves
  those lines.

## Shared brain
`setup-dots.sh` connects the brain once the host runs `deploy/founderos-hub-http.service` (`src/mcp/hub-http.ts`,
`/etc/founderos/hub-http.env`, `http://172.21.0.1:3100/mcp`, reachable only from the `opendots-computers` network):
- claude and agy in every computer get the `turicks-brain` MCP with the **brain-only** token: memories, never mail or
  calendar. agy's entry lives in `~/.gemini/config/mcp_config.json` (`agy mcp list` shows it); a rerun replaces the
  laptop-era stdio entry the Builder's agy used to carry.
- The Chief Dot gets a `turicks-brain` Connection with the full token (calendar and mail reads), kept in the app's
  SQLite. Reads run on their own; brain writes and `call_connected_tool` stay on Ask first.

## Founder steps, once
1. Tailscale: open the login URL printed by `sudo tailscale up --hostname=turicks-dots` on the VPS, and install
   Tailscale on the phone with the same account. The first `tailscale serve` prints a `login.tailscale.com/f/serve?...`
   link: open it once to turn on HTTPS for the tailnet.
2. CopilotKit key, on the laptop:
   `git clone https://github.com/CopilotKit/OpenDots.git /tmp/od && cd /tmp/od && cp .env.example .env && npx copilotkit@latest login && npx copilotkit@latest project select`.
   Copy the `CPK_INTELLIGENCE_API_KEY=` and `CPK_TELEMETRY_ID=` lines into `/opt/opendots/app/.env`.
3. Owner token for the phone login: `ssh founderos-vps 'grep ^OWNER_TOKEN= /opt/opendots/app/.env'`. Move it to the
   phone through a password manager and paste it once. Set Tailscale on the phone to Always-on VPN.
4. Logins: ask the Builder in chat to run `dot-login claude start` (and `agy`, `gh`), then rerun `setup-dots.sh` to
   copy them into the other computers.

## Operating
- Update: copy this directory to `/opt/opendots/deploy/`, run `bash /opt/opendots/deploy/install.sh`, restart each
  computer (`POST /api/dots/<id>/computer/stop`, then `.../start`, owner token, JSON body `{}`; `/workspace` and its
  logins survive), then `bash /opt/opendots/deploy/setup-dots.sh`.
- Status: `cd /opt/opendots/app && docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml -f compose.turicks.yml ps`
- Model: `OPENAI_MODEL` in `.env` (OpenRouter), then rerun `install.sh`.
- Prompts: max 2000 characters each (the script refuses longer). `setup-dots.sh` overwrites edits made in the app,
  so it is the source of truth.
- Rules that stay out of git (the Oplify instructions): keep them on the VPS as `/opt/opendots/local-rules/<owner>.md`
  (`scp ~/Oplify.in/CLAUDE.md founderos-vps:/opt/opendots/local-rules/OplifyMessage.md`) and rerun `setup-dots.sh`.
  claude and agy read `/workspace/local-rules/<owner>.md` before working in that owner's repos.
- Memory: each computer may use 2 GiB; the VPS has 7.6 GiB with Oplify on it.

**Security (accepted by the founder, 2026-10-13):** computers run repo code as root in a privileged container. That
code can read every login in the computer (the founder's gh and claude logins) and can reach the VPS host itself.
Use the Dots only on the founder's own repos, never on outside contributors' PRs. Network access is open.

## Test services
A computer has no docker. `team-services` runs Postgres and Redis as local processes: 127.0.0.1 only, throwaway data
in `/tmp/team-services`, Postgres 16 with pgvector (`shared_buffers=32MB`, 20 connections), Redis capped at 64 MB.

```
team-services start postgres redis   # redis:6380 for a repo whose tests hardcode that port; running it again is a no-op
team-services run npm test           # with the lines below exported
team-services env                    # DATABASE_URL, TEST_DATABASE_URL (postgres://team:team@127.0.0.1:5432/team),
                                     # REDIS_URL, REDIS_HOST, REDIS_PORT
team-services status | stop          # stop deletes the data
```

FounderOS and Oplify integration tests skip when the database is unreachable, so a green run without
`team-services start` tested nothing.
