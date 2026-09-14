# VPS daemons — pr-brain, agent-dispatch

Source of truth for the two bash daemons that run the Brain/Doer agent loop on
`founderos-vps`. Until 2026-09-14 these existed **only** as hand-edited files
in `~/bin/` on the VPS — no git history, no PR review, no rollback, no diff
between "what's running" and "what was intended." See
`docs/sessions/2026-09-14-agent-loop-root-fixes.md` for the incident that made
that gap visible: 3 fully-gated, CI-green PRs sat unmerged for 4 days because
nothing in the loop could merge, and the review daemon's dirty checkout was
inventing "pre-existing failure" excuses for tests that pass cleanly on main.

## What runs where

| Daemon | VPS path (deployed, live) | Crontab | What it does |
|---|---|---|---|
| `pr-brain` | `~/bin/pr-brain` | `*/20 * * * *` | Gates every open PR authored by this account: re-runs `pnpm gate`, runs the `pr-adversary` protocol, approves / pushes a fix / requests changes, then **merges** once cleared (added 2026-09-14 — see below). |
| `agent-dispatch` | `~/bin/agent-dispatch` | `*/15 * * * *` | Claims one `agent:ready` GitHub issue, checks out a branch in `/opt/agy-workspace/founderos`, invokes Antigravity (`agy`) to implement it, opens a draft PR to `beta`. |

Both read config from `~/.claude/pr-brain.repos` / env vars — see each
script's own header comment for the full list.

## Deploying a change

The crontab invokes the file at `~/bin/<name>` directly — it does **not**
check out this repo on the VPS and run from a checkout. A commit here has
zero effect on prod until copied over by hand:

```bash
# from a machine with founderos-vps SSH access, after merging to main:
scp deploy/vps-daemons/pr-brain founderos-vps:~/bin/pr-brain
scp deploy/vps-daemons/agent-dispatch founderos-vps:~/bin/agent-dispatch
ssh founderos-vps 'chmod +x ~/bin/pr-brain ~/bin/agent-dispatch'
# verify the deployed copy matches this repo:
shasum -a 256 deploy/vps-daemons/pr-brain deploy/vps-daemons/agent-dispatch
ssh founderos-vps 'sha256sum ~/bin/pr-brain ~/bin/agent-dispatch'
```

That manual step is a known gap, not fixed by importing these files — it
moves the problem from "no version control" to "version controlled but not
auto-deployed," which is strictly better and is as far as this task's scope
goes. A future improvement would be a small systemd/cron-triggered `git pull`
+ diff-and-copy step; not built here because it wasn't part of what broke.

## Keeping this copy honest

This file drifts the moment someone hand-edits the VPS copy directly instead
of going through a commit here. There is no CI check enforcing that the two
match (rule #27: a rule with no mechanism decays) — if you suspect drift, the
`shasum` comparison above is the fastest way to confirm it.
