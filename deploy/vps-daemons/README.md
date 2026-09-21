# VPS daemons — pr-brain, agent-dispatch

Source of truth for the two bash daemons that run the Brain/Doer agent loop on
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
| `pr-brain` | `deploy/vps-daemons/pr-brain` | `~/bin/pr-brain` | `*/20 * * * *` | Gates every open PR authored by this account: re-runs `pnpm gate`, runs the `pr-adversary` protocol, approves / pushes a fix / requests changes, then **merges** once cleared — except in an employer/org repo (`repo_owner != $OWNER`, e.g. `OplifyMessage`), where it marks the PR ready and always leaves the merge to a human (restored 2026-09-21). |
| `agent-dispatch` | `deploy/agent-dispatch` | `~/bin/agent-dispatch` | `*/15 * * * *` | Iterates every repo in `ISSUE_REPOS`, claims one `agent:ready` GitHub issue per tick, checks out a branch in the matching `/opt/agy-workspace/<repo>` workspace, invokes Antigravity (`agy`) to implement it, opens a draft PR. |

Both read config from `~/.claude/pr-brain.repos` / env vars — see each
script's own header comment for the full list.

## Deploying a change

The crontab invokes the file at `~/bin/<name>` directly — it does **not**
check out this repo on the VPS and run from a checkout. A commit here has
zero effect on prod until copied over by hand:

```bash
# from a machine with founderos-vps SSH access, after merging to main:
scp deploy/vps-daemons/pr-brain founderos-vps:~/bin/pr-brain
scp deploy/agent-dispatch founderos-vps:~/bin/agent-dispatch
ssh founderos-vps 'chmod +x ~/bin/pr-brain ~/bin/agent-dispatch'
# verify the deployed copy matches this repo:
shasum -a 256 deploy/vps-daemons/pr-brain deploy/agent-dispatch
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
