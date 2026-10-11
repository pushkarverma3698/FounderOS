# OpenDots on founderos-vps

CopilotKit OpenDots (pinned `625452e`) runs in Docker under `/opt/opendots/app`, on `127.0.0.1:4310`.
Each Dot's computer is `opendots-computer-turicks:1`: the pinned OpenBot computer plus `claude`, `agy`,
`gh`, git, tmux, `run-bg` and `team-shift`. Plan and decisions: `docs/plans/2026-10-10-opendots-migration.md`.

| File | Purpose |
|---|---|
| `install.sh` | Install or update: clone, secrets, build all images, start, health check |
| `computer.Dockerfile` | Agent computer image |
| `compose.turicks.yml` | Points the supervisor at that image |
| `team-shift` | One engineering shift in one shell call: `team-shift architect\|builder\|reviewer` reports or collects the role's claude run, else claims the oldest queued item and starts claude on it with the role brief (`team/`) and a per-role tool allowlist |
| `team/` | claude's briefs: `team.md` (shared rules) plus one file per role |
| `run-bg` | Long commands past the 70 s shell limit: `run-bg start <name> claude -p "..."`, then `run-bg wait <name>` (up to 60 s) until `exit=` |
| `opendots-turicks.patch` | Our OpenDots changes, applied by `install.sh` after a clean checkout: a turn or task may last 15 min (upstream: 90 s); a turn may make 12 model calls (upstream: 5), and a turn still asking for tools at that limit fails instead of ending as completed; a recurring task retries one interval after a failed or interrupted run (upstream: waits for Run); a scheduled shift sends the model only its own turn; a model reply may be 16,000 tokens (upstream: 2,200), and a reply cut off at that limit fails the turn instead of ending it as completed; the web app remembers the owner token in `localStorage` (upstream: `sessionStorage`, so every new tab asked again) |
| `setup-dots.sh` | Creates or updates the Chief of Staff and the engineering team (Architect, Builder, Reviewer): prompts, computers, logins, paused shift tasks without an interval, `/opt/opendots/shift-tasks` and the hourly `shift-cron` crontab line (`SHIFT_SECONDS`, default 3600). Idempotent |
| `shift-cron` | Host cron, every 60 min: runs `team-shift <role> --check` in each computer (no model call) and runs a shift task only when it prints `Due:` or the check fails. Log: `/opt/opendots/shift-cron.log` |
| `dot-login` | In the computer, driven from chat: `dot-login <claude\|agy\|gh> start [email]` gives a sign-in link, `finish <code\|url>` installs the proved login, `logout`, `status` |
| `seed-cli-logins.sh` | Fallback over SSH: log a computer into claude (pasted `claude setup-token` token) and agy (the VPS's antigravity login) |

## Founder steps, once
1. Tailscale: open the login URL printed by `sudo tailscale up --hostname=turicks-dots` on the VPS, and
   install Tailscale on the phone with the same account. The first `tailscale serve` prints a
   `login.tailscale.com/f/serve?...` link: open it once to turn on HTTPS for the tailnet.
2. CopilotKit key, on the laptop:
   `git clone https://github.com/CopilotKit/OpenDots.git /tmp/od && cd /tmp/od && cp .env.example .env && npx copilotkit@latest login && npx copilotkit@latest project select`.
   Copy the `CPK_INTELLIGENCE_API_KEY=` and `CPK_TELEMETRY_ID=` lines into `/opt/opendots/app/.env`.
3. Owner token for the phone login: `ssh founderos-vps 'grep ^OWNER_TOKEN= /opt/opendots/app/.env'`. Move it
   to the phone through a password manager and paste it once: the browser remembers it (a token the server
   rejects is forgotten and the unlock screen comes back). The phone reaches the app only on the tailnet, so set
   Tailscale on the phone to Always-on VPN; when the phone drops off the tailnet the link stops loading.
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
  The model is jev-router, which picks a model and reasoning effort per request, so it can't be pinned. Some of its
  picks need OpenRouter's 18+ confirmation (OpenRouter → Settings → Preferences); without it those turns fail with a 403.
- Output limit: a model reply may be 16,000 tokens (reasoning included). A reply that hits the limit ends the turn
  as failed with "The model's reply was cut off at the output limit." A cut-off tool call is never run, and a
  shift retries one interval later. Upstream's 2,200 cut coding replies off mid-file and still reported "completed".
  OpenRouter reports a cut-off tool call as `finish_reason "tool_calls"`, so the patch also checks
  `native_finish_reason` (`max_output_tokens`, `MAX_TOKENS`), the whole budget used, and tool arguments that do not
  parse.
- Dot instructions (system prompts), max 2000 characters each (the script refuses longer). For a quick try, edit in the app: "…" next to the Dot,
  then "Role instructions". To keep a change, edit `CHIEF` or `dot_prompt` in `setup-dots.sh` (the engineers' working rules are in `team/`, baked into the image), copy it to
  `/opt/opendots/deploy/`, and run `ssh founderos-vps 'bash /opt/opendots/deploy/setup-dots.sh'`. That script overwrites
  edits made in the app, so this file is the source of truth.
- Restart a computer to pick up a rebuilt image: `POST /api/dots/<id>/computer/stop`, then `.../start` (owner token, JSON body `{}`).
- Memory: each computer may use 2 GiB; the VPS has 7.6 GiB with Oplify on it. With the 3 team computers up, 4.2 GiB was still available (2026-10-10).

## Engineering team
Three Dots act as employees, each with a computer holding `claude`, `agy` and `gh`. They talk to each other
only through GitHub labels. Host cron (`shift-cron`) checks each role every 60 minutes with the read-only
`team-shift <role> --check` and runs that Dot's "shift" task only when there is work, so an idle hour makes no
OpenRouter call. A Dot is only a dispatcher: its shift runs `team-shift <role>` once and replies with the output, so the paid Dot model makes 2-3
calls a shift. claude does the engineering (subscription, not OpenRouter) with the role brief from `team/` and an
allowlist: nobody may merge, force-push, rebase or call `gh api`; only the Builder may edit, commit, push and open
PRs. Before 2026-10-11 the Dot did the work itself and spent ~$7.75 of OpenRouter credit in one afternoon.

- **Give them work:** ask the Architect in chat, or open an issue labelled `agent:plan` in a repo listed in
  `TEAM_REPOS` (default `pushkarverma3698/opendots-sandbox`). Add repos with
  `TEAM_REPOS="owner/a owner/b" bash /opt/opendots/deploy/setup-dots.sh`.
- **Your part:** tell the Chief of Staff which `agent:approved` PR to merge (it merges, then closes the issue
  with a link to the PR), and answer `agent:blocked` items through the Chief (it comments your answer and swaps
  `agent:blocked` for the queue label). Issues marked `agent:in-pr` whose PR merged into a non-default branch are
  closed by the Builder on a later shift.
- **Start / stop:** shifts are created paused, and cron never wakes a paused task. Start each once in the app
  (Tasks → Run) or `POST /api/tasks/<id>/actions {"action":"run"}`. Kill switch: pause the three tasks (pausing
  also stops a running shift); to stop the checks too, delete the `# opendots-shift` line from `crontab -e`.
- **Pace:** a shift that collects a finished run starts the next item an hour later, so each role does about one
  item every 2 hours. Faster costs nothing while idle: `SHIFT_SECONDS=900` (a divisor of 60 min) and rerun
  `setup-dots.sh`.

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
`team-shift` keeps one claude run per role (`/workspace/runs/shift-<role>.job`). Next shift: still running →
"Working"; finished with the claim label moved → "Done" plus claude's `RESULT:` line; finished without moving it,
failed, or over 90 min → the item is blocked with claude's last output. A lost run is restarted. A 4th review round
blocks instead of starting.

**agy fallback:** when claude stops on its usage limit (`hit your ... limit`, `usage limit`, `quota reached`), the
Builder and Reviewer start `agy --print` on the same item with the same brief and keep the claim; the job file
records `agy` and later shifts report "agy run". agy has no `--allowedTools`, so `team-shift` writes the role's
claude allowlist into `~/.gemini/antigravity-cli/settings.json` as `permissions.allow` / `deny` rules
(`command(git push)`, `read_file(*)`, `write_file(*)` for the Builder only), keeping the file's other settings. No
`--dangerously-skip-permissions`. The Architect's computer has no agy login, so its limit still blocks; a computer
without `antigravity-oauth-token` blocks too, and a failed agy run blocks without a second fallback.

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
