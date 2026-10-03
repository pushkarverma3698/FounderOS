# VPS daemons — pr-brain, agent-dispatch

Source of truth for the bash daemons that run the Brain/Doer agent loop on
`founderos-vps`. Until 2026-09-14 these existed **only** as hand-edited files
in `~/bin/` on the VPS — no git history, no PR review, no rollback, no diff
between "what's running" and "what was intended." See
`docs/sessions/2026-09-14-agent-loop-root-fixes.md` for the incident that made
that gap visible: 3 fully-gated, CI-green PRs sat unmerged for 4 days because
nothing in the loop could merge, and the review daemon's dirty checkout was
inventing "pre-existing failure" excuses for tests that pass cleanly on main.

**⚠️ `agent-dispatch` lives at `deploy/agent-dispatch` (repo root), not in this
directory.** A duplicate `deploy/vps-daemons/agent-dispatch` existed here too —
530 lines, single-repo only, predating all Oplify multi-repo work — and had
silently gone stale next to the file actually being deployed. Deleted
2026-09-21 (see `docs/sessions/2026-09-21-oplify-onboarding-and-safety-fixes.md`)
rather than left to keep drifting. `pr-brain` genuinely does live in this
directory; only `agent-dispatch`'s documented location was wrong.

## What runs where

| Daemon | Source in this repo | VPS path (deployed, live) | Crontab | What it does |
|---|---|---|---|---|
| `pr-brain` | `deploy/vps-daemons/pr-brain` | `~/bin/pr-brain` | `*/20 * * * *` | Gates every open PR authored by this account: re-runs `pnpm gate`, runs the `pr-adversary` protocol, clears it or requests changes (the `claude` engine may also push a fix), then **merges** once cleared. The reviewer is an engine, `PR_BRAIN_ENGINE`: **`agy` by default** (see "The reviewer" below), `claude` as before. A head whose only new commits are pr-brain's own fixes or clean merges of the base is not re-gated: the verdict is carried forward and the merge retried with no Claude session (2026-09-29) — except in an employer/org repo (`repo_owner != $OWNER`, e.g. `OplifyMessage`), where it marks the PR ready and always leaves the merge to a human (restored 2026-09-21). |
| `agent-dispatch` | `deploy/agent-dispatch` | `~/bin/agent-dispatch` | `*/15 * * * *` and `* * * * * … --kicked` | Sweeps every repo in its own `DEFAULT_REPOS` (the only list it reads), claims one `agent:ready` GitHub issue per repo per tick **if its brief is complete**, checks out a branch in the matching `/opt/agy-workspace/<repo>` workspace, invokes Antigravity (`agy`) to implement it, opens a draft PR. Every way a run can end without a PR is classified (see below) instead of all becoming `agent:failed`. |
| `onboard-repo.sh` | `deploy/onboard-repo.sh` | `~/bin/onboard-repo.sh` | — (run by hand, and `--check` by every agent-dispatch tick) | Puts a repo on the loop, or reports what it is missing. See "Adding a repo". |
| helpers | `deploy/lib/*.sh` | `~/bin/lib/*.sh` | — | Sourced by the daemons: `down-state.sh` (the pause/resume state machine and secret redaction, shared by both), `agy-failure.sh` (the failure classifier), `agy-run.sh` (one agy turn, streamed live into one Telegram message; shared by both) and `ci-state.sh` (what a PR's required CI checks say; shared by both). **A daemon refuses to start without them.** |

Both read config from `~/.claude/pr-brain.repos` / env vars — see each
script's own header comment for the full list.

## The reviewer (`PR_BRAIN_ENGINE`)

Claude's weekly limit paused every review for four days (2026-10-01 → 10-05), and the review half of the Telegram
loop stopped with it. `pr-brain` now has an engine:

| | `agy` (default) | `claude` |
|---|---|---|
| Runs | the Antigravity CLI as the `antigravity` user, in its own clone `/opt/agy-workspace/review/<repo>` on the PR head | headless Claude Code in `/opt/review/<repo>` |
| Model | `claude-sonnet-5-5-medium`, then `gemini-3.1-pro-high` if that one's quota is gone or agy no longer has it (`PR_BRAIN_MODELS`, best first; `agy models` lists what exists). **Never** the executor's `gemini-3.6-flash-medium`: the code skips it | `sonnet` (`PR_BRAIN_MODEL`) |
| Can push to the PR | **no** (the clone's push URL is disabled) | yes (verdict B) |
| Verdict | the model ends with `BRAIN-VERDICT: PASS` or `FAIL`; **the script** makes the PR ready/draft and posts the reviewed marker. No verdict line = a failed attempt | read from the PR's state, as before |
| Telegram | one message, edited while it runs: `Reviewing <repo>#<n>`, the last tool calls, the clock, the verdict | the gate's start and verdict |

Switch back with `PR_BRAIN_ENGINE=claude` in the pr-brain crontab line. The independence conditions (and why a
different model, a fresh conversation and no write path matter) are in the ADR-046 amendment of 2026-10-03.

**Quota is per model family on the Antigravity login.** On 2026-10-02 `claude-sonnet-4-6`, `claude-opus-4-6-thinking`
and `gpt-oss-120b-medium` all answered `RESOURCE_EXHAUSTED (code 429) … Resets in 69h26m28s` while every Gemini model
still worked (probed on the VPS). So a wall on one reviewer model moves the review to the next candidate, at the
preflight and in the middle of a review (the same PR is reviewed again at once, and the spent model is skipped for the
rest of the sweep). A name agy's catalog no longer has (2026-10-03: `claude-sonnet-4-6` became `claude-sonnet-5-5-*`) is skipped the same way and reported once; it used to pause the whole reviewer. The reviewer is paused, once, only when every candidate is out; the message names the models tried
and the reset time. A rejected login is not retried on another model: every model shares it. Probe a model by hand:
`sudo -u antigravity -i agy --new-project --model <name> --print "reply ok" --output-format text`; list them with
`agy models`. If you move the executor (`AGENT_DISPATCH_MODEL`), pr-brain follows it when it sees the same variable,
otherwise set `PR_BRAIN_EXECUTOR_MODEL` on its crontab line to the same value.

**What a sweep does not spend a review on.** A review is a whole agy session on the quota the executor shares, so a
sweep skips these (each is one log line; `pr-brain --pr N` is an explicit order and ignores all of them):

| Skipped | Why | What happens instead |
|---|---|---|
| a promotion or sync PR (head branch `beta`, `main`, `master`, `chore/promote-*`) | its work already passed its own gate | nothing: no marker, no comment |
| a head whose **required** CI is red | a review cannot clear it | pr-brain skips it. agent-dispatch (Pass B) reads the same CI state and sends Antigravity back with the failing check as the brief, counted like any re-dispatch (3, then `agent:blocked`). Someone else's PR: the founder is told once per head |
| a head whose required CI is still running | the result decides whether a review is worth it | deferred up to `PR_BRAIN_CI_WAIT_SWEEPS` sweeps (4), then reviewed anyway |
| any review past `PR_BRAIN_DAILY_MAX` (20, `0` = off) in 24 hours | the executor lives on the same quota | the sweep stops, one notice a day names the first PR waiting and the override |

Only **required** checks count (a failing staging deploy is not a red PR). When CI cannot be read (the base branch has no
required checks, `gh` fails) the review is spent as before: a quiet failure must not mean "never review". State:
`~/.claude/pr-brain.ci/` (what CI said about a head), `~/.claude/pr-brain.reviews` (one line per review started, last
24 h), `~/.claude/pr-brain.ceiling` (the day the notice was sent). Delete `pr-brain.reviews` to reset the ceiling.

## Live progress and the kick

`deploy/lib/agy-run.sh` runs agy with `--output-format stream-json` and edits **one** Telegram message every
20 s: `🔧 Antigravity #44 · owner/repo`, the clock and model, the last five tool calls (`✅ run npm test`,
`⏳ read src/…`). When the run ends it is left in the chat with the outcome appended (`📦 PR #9 opened`). It
used to show the last line agy printed: `</app_notification>`, `root agent idle; waiting…`.

Approving a `/task` files the issue and the bot appends a line to `~/.claude/agent-dispatch.kick`. The bot cannot
start the dispatcher itself (it runs under systemd with `NoNewPrivileges`, where every `sudo` fails, and `/tmp` is
private to it): a per-minute cron line, `agent-dispatch --kicked`, turns the note into a tick within a minute.
`deploy/sync-daemons.sh` installs that line (copied from the `agent-dispatch` line already in the crontab, so the
same user, PATH and env file), idempotently. With no note it exits at once, silently.

## Pause states: what the founder is told

A loop that stops and says nothing looks exactly like an idle one. Each way the
loop can stop is announced **once** on Telegram with the exact fix, silent for as
long as it lasts, and announced **once more** when it recovers.

| State | File | Cleared by |
|---|---|---|
| Antigravity auth failed (key or login rejected) | `~/.claude/agent-dispatch.down` (`auth`) | the key file's mtime changing (the new key is tried on the next tick), or deleting the file |
| `gh` logged out, a tool or `agy` missing | `~/.claude/agent-dispatch.down` (`gh-auth`, `missing-dep`, `agy-missing`) | recovering by itself: checked every tick |
| Antigravity quota exhausted | `~/.claude/agent-dispatch.quota-until` | the reset time passing |
| Reviewer unavailable (login, usage limit; names which engine) | `~/.claude/pr-brain.down` | the next sweep that reaches the reviewer |
| Repo not set up (workspace, labels) | `~/.claude/agent-dispatch.onboard-reported` | fixing it (`onboard-repo.sh`); a change in the list sends one more message |

How a failed Antigravity run is classified (`deploy/lib/agy-failure.sh`, tail of the log only,
on lines the CLI printed about its own failure, never a transcript that merely mentions a code):

| Class | What happens |
|---|---|
| quota | issue back to `agent:ready`; nothing starts until the reset time |
| auth | issue back to `agent:ready`; the whole loop pauses; a re-dispatch leaves the PR open and does not count the attempt |
| transient (timeout, 5xx, connection reset) | back to `agent:ready` with a `<!-- agent-transient: N -->` marker; the 3rd in a row is `agent:failed` with all three log tails in one comment |
| anything else | `agent:failed`, with the last 60 lines |

An issue whose description is missing any of the nine sections of
`.github/ISSUE_TEMPLATE/agent-task.md`, or has one that says nothing, is **not claimed**:
it gets `agent:needs-brief`, one comment listing what is missing and one Telegram message.
`~/bin/agent-dispatch --check-brief < body.md` runs the same check on a file.

Everything quoted to Telegram or a GitHub comment, and everything appended to the log, passes
through `redact_secrets` first, and the Gemini key reaches `agy` on stdin, never on a command line.

## Adding a repo

A repo lives in **one** list, `DEFAULT_REPOS` in `deploy/agent-dispatch`, held equal to
`DISPATCH_REPO_ALLOWLIST` (`src/tools/dispatch-repos.ts`) by a test. Add it with a one-line PR
(`pnpm repo:add <owner/repo>` edits both lists and the test fixture), then on the VPS:

```bash
ssh founderos-vps '~/bin/onboard-repo.sh owner/repo'   # clones /opt/review + /opt/agy-workspace, creates the 6 labels
ssh founderos-vps '~/bin/onboard-repo.sh --check'      # every repo in DEFAULT_REPOS, changes nothing
```

`ISSUE_REPOS` / `ISSUE_REPO` in the crontab line are **ignored** now (the daemon logs one warning per
tick while either is set): delete them with `crontab -e`.

## Deploying a change

The crontab invokes the file at `~/bin/<name>` directly — it does **not** run from a checkout.
The Deploy workflow (`.github/workflows/deploy.yml`) therefore has a step, **after** the app is
restarted and healthy, that runs `deploy/sync-daemons.sh` on the VPS:

- it copies `deploy/lib/*.sh` first, then `agent-dispatch`, `pr-brain` and `onboard-repo.sh` into
  `~/bin`, each written to `<name>.new`, chmod'd and `mv`'d into place (atomic, so a daemon that
  starts mid-copy never sees half a file, and a running one keeps its old inode);
- it compares the `sha256sum` of every deployed file with the checkout's and starts each daemon
  with `--help` from where it now lives (which proves the daemon finds its helpers);
- any mismatch fails the job and **names the file**. That step is separate from "Deploy over SSH"
  on purpose: a red "Sync VPS daemons" means the daemons are stale, not that production is down.

To do it by hand (or re-sync after a hand edit on the box): `ssh founderos-vps 'cd /opt/founderos && bash deploy/sync-daemons.sh'`.
To roll back: check out the previous commit's `deploy/` in `/opt/founderos` and run the same command,
or revert the merge and let the Deploy workflow re-sync.

*Assumption, not verified from a cloud session:* the deploy user's `~/bin` is the same `~/bin` the
crontab runs from. The sync prints the destination it used.

## Claude login that survives weeks (`~/.claude/pr-brain.token`)

An expired Claude login used to need someone to ssh in and run `/login`. pr-brain now reads a
long-lived token from `~/.claude/pr-brain.token` when that file exists:

```bash
ssh -t founderos-vps 'claude setup-token'        # prints a token once
# then on the VPS: line 1 = the token, line 2 = today's date (YYYY-MM-DD)
printf '%s\n%s\n' '<paste the token>' "$(date -u +%F)" > ~/.claude/pr-brain.token && chmod 600 ~/.claude/pr-brain.token
```

- The file is used **only if its mode is exactly 0600**; otherwise pr-brain warns once (Telegram) and
  ignores it.
- The token is exported as `CLAUDE_CODE_OAUTH_TOKEN` into the environment of the `claude` invocation
  only. It is never an argument, never logged (it is masked wherever text leaves the box) and never
  traced.
- **The token's lifetime is UNVERIFIED** until `claude setup-token --help` on the VPS confirms it. The
  330-day warning is a guess made before that was checked: pr-brain sends one Telegram warning when the
  date on line 2 is 330 days old, and again only if you replace the token (a new date re-arms it).
  Check the real lifetime the first time you create the token and adjust `TOKEN_WARN_DAYS` in
  `pr-brain` if it is shorter.

## Keeping this copy honest

A rule with no mechanism decays (rule #27). What enforces each half of "the box runs what the repo says":

- **deploy time:** the sha256 comparison in `deploy/sync-daemons.sh`, run by the Deploy workflow. A
  hand edit on the VPS is overwritten by the next deploy, so make changes here, through a PR.
- **CI:** `tests/unit/scripts/sync-daemons.test.ts` fails if a file a daemon sources is not in the copy
  list (the first deploy would break both daemons), and `tests/unit/scripts/deploy-workflow.test.ts`
  fails if the sync step disappears, moves before the restart, or leaks a secret.
- **by hand:** `ssh founderos-vps 'sha256sum ~/bin/agent-dispatch ~/bin/pr-brain ~/bin/onboard-repo.sh ~/bin/lib/*.sh'`
  against `sha256sum` of the same files in the checkout.
