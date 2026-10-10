# OpenDots on founderos-vps

CopilotKit OpenDots (pinned `625452e`) runs in Docker under `/opt/opendots/app`, on `127.0.0.1:4310`.
Each Dot's computer is `opendots-computer-turicks:1`: the pinned OpenBot computer plus `claude`, `agy`,
`gh`, git, tmux and `run-bg`. Plan and decisions: `docs/plans/2026-10-10-opendots-migration.md`.

| File | Purpose |
|---|---|
| `install.sh` | Install or update: clone, secrets, build all images, start, health check |
| `computer.Dockerfile` | Agent computer image |
| `compose.turicks.yml` | Points the supervisor at that image |
| `run-bg` | Long commands past the 70 s shell limit: `run-bg start <name> claude -p "..."`, then `run-bg wait <name>` (up to 60 s) until `exit=` |
| `opendots-turicks.patch` | Our OpenDots changes, applied by `install.sh` after a clean checkout: a turn or task may last 15 min and 150 tool steps (upstream: 90 s, 5); a recurring task retries one interval after a failed or interrupted run (upstream: waits for Run); a scheduled shift sends the model only its own turn |
| `setup-dots.sh` | Creates or updates the Chief of Staff and the engineering team (Architect, Builder, Reviewer): prompts, computers, logins, paused 15-min shift tasks. Idempotent |
| `dot-login` | In the computer, driven from chat: `dot-login <claude\|agy\|gh> start [email]` gives a sign-in link, `finish <code\|url>` installs the proved login, `logout`, `status` |
| `seed-cli-logins.sh` | Fallback over SSH: log a computer into claude (pasted `claude setup-token` token) and agy (the VPS's antigravity login) |

## Founder steps, once
1. Tailscale: open the login URL printed by `sudo tailscale up --hostname=turicks-dots` on the VPS, and
   install Tailscale on the phone with the same account. The first `tailscale serve` prints a
   `login.tailscale.com/f/serve?...` link: open it once to turn on HTTPS for the tailnet.
2. CopilotKit key, on the laptop:
   `git clone https://github.com/CopilotKit/OpenDots.git /tmp/od && cd /tmp/od && cp .env.example .env && npx copilotkit@latest login && npx copilotkit@latest project select`.
   Copy the `CPK_INTELLIGENCE_API_KEY=` and `CPK_TELEMETRY_ID=` lines into `/opt/opendots/app/.env`.
3. Owner token for the phone login: `ssh founderos-vps 'grep ^OWNER_TOKEN= /opt/opendots/app/.env'`.
4. Claude login for the Builder Dot: run `claude setup-token` on the laptop and keep the `sk-ant-...` token
   for the seed step below. The VPS has no claude login to reuse.

## Operator steps after those
- HTTPS for the phone: `sudo tailscale serve --bg 4310`, then set `APP_ORIGIN=https://turicks-dots.taile5afc3.ts.net,http://localhost:4310`
  in `.env` and rerun `install.sh`.
- After the Builder Dot's computer is started: `ssh -t founderos-vps 'bash /opt/opendots/deploy/seed-cli-logins.sh'` lists
  computers; rerun it with the container name and paste the token. It stores the token in `/workspace/.claude-token`;
  the image's `claude` wrapper reads it, because the Dot's shell sources no profile.

## Operating
- Status: `cd /opt/opendots/app && docker compose -f compose.yml -f compose.computers.yml -f compose.computers-app.yml -f compose.turicks.yml ps`
- Model: `OPENAI_MODEL` in `.env` (OpenRouter, `OPENAI_BASE_URL=https://openrouter.ai/api/v1`), then rerun `install.sh`.
- Dot instructions (system prompts), max 2000 characters each (the script refuses longer). For a quick try, edit in the app: "…" next to the Dot,
  then "Role instructions". To keep a change, edit `CHIEF`, `TEAM`, `ARCHITECT`, `BUILDER` or `REVIEWER` in `setup-dots.sh`, copy it to
  `/opt/opendots/deploy/`, and run `ssh founderos-vps 'bash /opt/opendots/deploy/setup-dots.sh'`. That script overwrites
  edits made in the app, so this file is the source of truth.
- Restart a computer to pick up a rebuilt image: `POST /api/dots/<id>/computer/stop`, then `.../start` (owner token, JSON body `{}`).
- Memory: each computer may use 2 GiB; the VPS has 7.6 GiB with Oplify on it. With the 3 team computers up, 4.2 GiB was still available (2026-10-10).

## Engineering team
Three Dots act as employees. Each has its own prompt and a computer with `claude` and `gh` (the Builder and
Reviewer also have `agy`). They talk to each other only through GitHub labels. No scripts orchestrate them:
OpenDots' own scheduler runs one "shift" task per Dot every 15 minutes, and each shift handles one item.

- **Give them work:** ask the Architect in chat, or open an issue labelled `agent:plan` in a repo listed in
  `TEAM_REPOS` (default `pushkarverma3698/opendots-sandbox`). Add repos with
  `TEAM_REPOS="owner/a owner/b" bash /opt/opendots/deploy/setup-dots.sh`.
- **Your part:** tell the Chief of Staff which `agent:approved` PR to merge (it merges, then closes the issue
  with a link to the PR), and answer `agent:blocked` items through the Chief (it comments your answer and swaps
  `agent:blocked` for the queue label). Issues marked `agent:in-pr` whose PR merged into a non-default branch are
  closed by the Builder on a later shift.
- **Start / stop:** shifts are created paused. Start each in the app (Tasks → Run) or
  `POST /api/tasks/<id>/actions {"action":"run"}`. Kill switch: pause the three tasks (pausing also stops a running
  shift).

| Event | Remove | Add |
|---|---|---|
| Architect claims an issue | `agent:plan` | `agent:planning` |
| Architect: plan done | `agent:planning` | `agent:build` (big work: child issues `agent:build`, parent `agent:epic`) |
| Builder claims an issue / a PR | `agent:build` / `agent:changes` | `agent:building` |
| Builder opens or updates the PR | `agent:building` | PR `agent:review`; issue `agent:in-pr` |
| Reviewer claims a PR | `agent:review` | `agent:reviewing` |
| Reviewer passes (also `gh pr ready`) | `agent:reviewing` | `agent:approved` |
| Reviewer asks for changes | `agent:reviewing` | `agent:changes` (4th round blocks instead) |
| Anyone blocks | every queue and claim label, on issue and PR | `agent:blocked` |

Issues carry `plan`, `build`, `in-pr`, `epic`, `blocked`; PRs carry `review`, `changes`, `approved`, `blocked`.
A shift first resumes its own claimed item (branch, open PR, `run-bg list`) before taking new work.

**Scheduler behaviour (read in OpenDots source, pinned `625452e`, plus our patch):** one task runs at a time.
Upstream, a recurring task schedules its next run only after a *completed* run; with the patch it also comes
back one interval after a failed or interrupted run. Changing a task's settings or pausing it interrupts the
running shift. Every shift posts into the same "Shift" conversation, but the model gets only the current
shift's turn, so a shift costs the same however long that thread gets.

**Security limit (known, accepted for the sandbox):** the computers run repo code (tests, scripts) as root,
and that code can read every login in the computer: on 2026-10-10 `/workspace/.claude-token` and the gh login
were readable in all three. Prompts can't prevent this, and the gh token is the founder's, so the Architect can
technically push too. Until per-role fine-grained GitHub tokens are installed (`dot-login gh`), use the team only
on the founder's own repos, never on outside contributors' PRs. Computer network access is open.
