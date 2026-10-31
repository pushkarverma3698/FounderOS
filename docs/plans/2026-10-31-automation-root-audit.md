# Tracker-first routine: audit, evidence and plan

**Date:** 2026-10-31. **Status:** Approved 2026-10-31; building. See "Progress" at the end for where it stands.
**Replaces:** this file's earlier "pause generalising, Option A first" version (brain decision 346c5348). The founder overruled it: build in `claude-agent-setup`, make the tracker the brain, then move BachelorHouse and Oplify onto it.
**Depth:** Full. It touches cron, concurrency, deploy and messages sent to the founder.

## Verdict

The automation does not run unattended end to end. Build, review and merge work: 56 BachelorHouse PRs merged since 10-25, backlog at 64/118 backend tasks. Everything around that middle fails: who owns a task, whether a run survives, whether leftover work comes back, and how the founder hears about it. `routine-verdict` has never printed YES.

Your design fixes the biggest gap. Today GitHub is the real brain and the tracker is a report written once a day by one routine. The plan turns that around.

## What the checks found

Labels: **Ran** means reproduced or read from command output this session. **Code-read** is a hypothesis. **Not verified** says why.

### The 5 items you asked me to verify

| Item | Result | Status |
|---|---|---|
| Systemd kill on update | Reproduced at $0 on an isolated HOME with a fake API. Today's unit shape fails the session with the same log sequence as the 10-31 06:35 kill. | Ran |
| `routine-new` on a fresh repo | Not run, because it writes labels, protection and timers. It stops on an empty repo and is hardwired to labels (`routine-new:40-45,127`). | Code-read. Tested in step 3. |
| Oplify staging hours | Scheduled E2E failed 9 of 9. Daytime dispatch passed 4 of 7, and its 3 failures started 16:03 or later. Inferred up-hours about 06:00-13:00 UTC. | Runs are real, the exact schedule is not verified (no AWS access) |
| Fence refusals | Fixed. 39 refusals on 10-27 from the old `-w` runs, 0 in any role since 10-28 (was 27-39% of builder calls on 10-26). | Ran |
| Reaper kills | Still a live problem. 64 memory-pressure kills in 5 days (19, 1, 27, 6, 11), on running eslint, tsc, lint and worker processes. Whether each was retried is not verified. | Ran |
| Claude Code's own features | From docs and code only: dynamic workflows have no usage-limit pause in background sessions; cloud schedules have no VPS tools or Telegram; Projects has no scheduler. Keep systemd and `--bg`. | Not run. `claude respawn` gets one small test. |

### Why runs die

Test of the update kill. Each row swaps the launcher while a session is working:

| Unit shape | Session after update | Supervisor crash |
|---|---|---|
| Today's | Failed, API connection dropped 34s after the swap | Not tested |
| `ExitType=cgroup` | Survives, same worker pid | Worker survives, but nothing restarts the supervisor |
| `KillMode=process` | Survives, but the unit loops and orphans processes on stop. Rejected. | Not tested |
| Wrapper loop around `daemon run` | Survives, same worker pid, unit stable | Not verified |

Mechanism: when the supervisor sees a new launcher version it starts a successor in the same cgroup and exits. systemd then kills the whole cgroup, including the successor and the adopted worker. All three supervisors restarted at 06:35:05. `DISABLE_AUTOUPDATER` is set nowhere and `autoUpdatesChannel` is `stable` on all three profiles.

After the kill, nothing recovers the run. e1dfd548 is `state=failed`, its last turns have no error, and `claude-routine-resume` has 0 lines mentioning it. `resume_one` exits silently in that state (code-read).

### Tracker today (`06-task-backlog.csv`, 127 rows: 63 Not started, 58 Done, 5 In progress, 1 In review)

- Only the bh-morning lead writes it. Phone and laptop sessions never do (`bh-task.md`: "set by the next bh-morning run").
- 11 rows disagree with merged PRs, all confirmed against PR bodies: T-205, T-206, T-214, T-247, T-305 (Not started), T-125, T-145 (In progress), T-106 (In review), T-139, T-242, T-244 (Part-of merges, still Not started).
- The VPS pack clone holds an unpushed commit `6255035`: T-305 Done, T-141 update, T-170 Done to In progress with "left: AD51 jobs admin, U9 consents route". `bh-morning.md` says the clone has no remote, but it does. T-170 needs a human-grade check because that note may be real work.
- Missing fields: owner, environment, run id, branch, PR, blocker, next step, last updated.
- A claim protects only the build. Review and merge have no owner, so a lead waiting on CI looks abandoned after 2 hours. That is how the routine adopted the phone session's #100-#102 on 10-31.

### Usage stops and blockers

| Session | Stopped | Resumed by | Gap |
|---|---|---|---|
| 2683d536 routine | 10-27 06:40 | `--resume-stopped` | 4h37 |
| 6c8a4a6c phone | 10-27 21:42 | You | 9h16 |
| fb4fa358 phone | 10-28 13:37 | Lead's message to its builders | 6h |
| fb4fa358 phone | 10-29 11:33 | You | 4h48 |
| fb4fa358 phone | 10-29 17:43 | You | about 12h45 |
| a8f339fa phone | 10-30 13:43 | You | 14h24 |

`--resume-stopped` selects only `kind=background` sessions named `routine: …` (code-read), so a phone session can never be picked up. No blocker path exists in code: a block reaches you only if a lead writes it in its report.

### Other evidence

- Morning runs: 10-28 finished; 10-29 killed by a manual start; 10-30 finished; 10-31 killed at 06:35.
- Plumbing churn since 10-24: `bh-morning.md` patched 21 times, `token-guard.py` 16, `bh-ready.py` 10, `claude-routine` 8. Prompts are acting as the program.
- 7 kernel OOM kills, all 10-29 10:35-10:38, on a day with two leads.
- BachelorHouse CI runs on the VPS because Actions runs 0 steps (failed payment). `main` is still "Initial commit", no staging, no prod. **BachelorHouse cannot get a prod-ready verdict until that changes.** It can get "merged, tests passed, not deployed".
- Oplify: 44 open issues, 1 `agent:ready`, 9 blocked; 34 HB-* created today. #195 is open with `Staging E2E` and `Deploy to EC2 Staging` red.
- Drift: every installed file matches git except `agent-jobs/bh-task.md` (VPS is ahead by one paragraph). `claude-agent-fetch`, `claude-clutter-clean`, `claude-remote-serve`, `claude-remote-update`, `claude-session-reaper`, `routine-worktree` and their units exist only on the VPS, so a new machine wouldn't get them.
- Correction to my earlier audit: I said usage-limit lines appear only in phone sessions. Routine 2683d536 also hit one on 10-27.

## The design

Every environment runs the same thing: one tool, one one-liner, one tracker. Rules live in code, not prompts.

### 1. The tracker is the brain

- One CSV per project in its own repo, same shape as BachelorHouse's. New columns: Owner, Environment, Run, Branch, PR, Blocker, Next step, Updated. Status becomes a fixed list: Not started, Claimed, Building, In review, Waiting, Blocked, Done.
- One tool writes it, `tracker`, and nothing else does. Writes go through the GitHub contents API with sha compare-and-swap. A stale sha gets 409, the tool re-reads, merges its one row and retries. Every environment reaches the same file at once, with no clone to go stale.
- Commands: `tracker next`, `tracker claim`, `tracker beat`, `tracker block`, `tracker done`, `tracker sync`.
- GitHub still wins on one fact: a merged `Closes T-NNN` means Done. `tracker sync` runs on every read and fixes drift, so the 11-row problem can't return.
- `bh-ready.py` and `oplify-ready.py` become per-project config. GitHub labels and issues stop being the queue.

### 2. No overlap from any environment

- `tracker claim T-NNN` makes the branch through `claim-branch` first (the atomic GitHub ref is the lock), then writes owner, environment and run into the row.
- The owner holds the row through build, review and merge. This closes the 10-31 adoption hole.
- Each `tracker` write refreshes the lease. A lead waiting on CI runs `tracker beat`.
- A row whose lease is older than 6 hours is a leftover anyone may take, with `claim-branch --resume`. Six hours is longer than a usage window.
- The push hook refuses a push when this session is no longer the row's owner, so an old session that wakes up after a takeover stops instead of colliding.

The one-liner from phone, laptop or routine is the same: "work the tracker". It runs `tracker next` and does what comes back.

### 3. Leftovers first

- `tracker next` lists LEFTOVER before NEW.
- `tracker claim` exits non-zero on a new task while a leftover is takeable. A routine cannot start new work over old work, because the tool refuses rather than a prompt asking nicely.
- An hourly sweep replaces `resume_one` and its state-file guessing. It looks at the tracker: leftovers exist and no lead is live for this project and usage is available, so it starts a fresh lead with the same one-liner. Phone and laptop work comes back the same way, because the sweep reads rows and not session kinds.

### 4. Blockers reach you immediately

- `tracker block T-NNN "<what>" --needs founder|stakeholder` writes the row and sends Telegram at once through `claude-notify`.
- The message carries project, task, environment, run, session link, what is blocked and the exact action. It sends once per row and reason, and repeats daily while still open.
- The sweep also reports a dead run once: "bh-morning e1dfd548 died 06:35, T-207 back in queue". Silence stops being possible.
- Telegram first, as you said. Email stays out unless Telegram proves not enough.

### 5. Morning and evening

One config per project with `SCHEDULE="03:04 15:00"`. One timer, several times. A slot that finds a live lead for the project skips and says so. Adding an evening run is one edited line.

The config holds what differs per repo: tracker location and columns, repo list and merge order, work base and PR target, branch pattern, CI command, test environment recipe, post-merge deploy check, E2E step and its up-hours, promotion step, daily cap, accounts.

### 6. Runs survive

- Remove the trigger: set `DISABLE_AUTOUPDATER=1` on all profiles. `claude-bgd-update` updates only when no session on the box is working. **Hypothesis:** this stops the launcher moving under a live run. Test it first with the same $0 harness.
- If it fails, use the wrapper loop, after its supervisor crash test.
- Any death is now a recoverable event, because state is in the tracker and not the session.

### 7. Memory on a 7.7 GB box

Cap builders per host in `tracker claim`, and run lint, tsc and tests through a host-wide slot, so builders queue instead of being killed. The reaper's pressure kill then handles only orphans. The cap starts at 3 and gets measured. **Hypothesis:** this ends the 64 kills without new hardware.

### 8. Verdict is three facts, sent by code

Did the run finish, what merged and what proved it, what needs you. Idle prints idle, not NO.

- **Oplify prod-ready:** CI green, merged to `beta`, staging deploy green, one Staging E2E pass, draft promotion. You merge.
- **BachelorHouse:** tests green and merged, stated as not deployed.

## Build order (subagents build, I plan and review)

| Step | What | Estimate |
|---|---|---|
| 1 | `tracker` tool with tests in `claude-agent-setup`, live compare-and-swap on a throwaway copy, token-guard check on the PUT | Half a day |
| 2 | Update test, then autoupdate off and the idle slot. Needs a `claude-bgd` restart. | 2 hours |
| 3 | `routine-new` rebuilt on the config, labels gone, multi-time schedule, deliberate run on a throwaway repo | Half a day |
| 4 | Short lead prompt and "work the tracker" skill, push-hook owner check, sweep, blocker messages, verdict; delete `resume_one`, adoption rules and most of `bh-morning.md` | 1 day |
| 5 | Six VPS-only scripts into the repo, `bh-task.md` back in git, builder cap and CI slot | Half a day |
| 6 | BachelorHouse: new columns, 11 rows synced, `6255035` resolved, T-170 checked against the spec, bh-morning moved over | Half a day |
| 7 | Oplify: new tracker from the 44 open issues, API-first order, routine dispatches E2E in up-hours, cron moved, #195 gets a fresh same-tree E2E | Half a day |

Oplify's tracker goes in a new private repo, the same as the BachelorHouse pack, because a protected default branch would refuse contents-API writes.

## Acceptance: the edge cases as tests

Each one gets a real test before migration, and the list grows when a new one turns up.

| Case | Expected |
|---|---|
| Routine holds T-X, phone one-liner | Phone gets the next task, no second branch |
| Phone holds T-X, routine fires | Routine skips T-X and says why |
| Lead waits on CI for 3 hours | Row stays owned |
| Usage ends mid-task, any environment | Row goes stale, work resumes after reset, no new tasks first |
| Old session wakes after a takeover | Push refused, session stops |
| Run killed mid-build | One Telegram, fresh lead continues |
| Crash between branch and row write | `tracker next` reconciles it |
| Two writers same second | One gets 409, retries, both rows correct |
| Task blocked on you or a stakeholder | Telegram within a minute, with environment and run |
| PR merged by hand on github.com | Next read marks it Done |
| Claude Code update during a run | Run stays alive or update waits |
| Evening slot while morning is live | Slot skips and says so |
| Staging box off | E2E waits for up-hours, no false red |
| Two leads at peak memory | 0 kills of live jobs |

**Exit test:** 3 timer-fired runs in a row on each project finish with a report and no manual restart, 0 duplicate builds, every installed file matches git. Then bh-morning's timer goes back on.

## Live state (2026-10-31, about 14:30 UTC)

- `claude-routine@bh-morning.timer` is stopped by your command (13:18:10, user `founderos`). 11-01 03:04 will not fire. Oplify-nightly still fires 11-01 09:30.
- Phone session a8f339fa is busy. Open PRs #103, #106, #107, #108. Not touched.
- Leftover test scraps on the VPS: `/var/tmp/x-bgd`, `/tmp/x-bgd`, `/tmp/x-cas`, `/tmp/x-aud`. No test units or processes remain.

## NOT VERIFIED

- Wrapper loop under a supervisor crash: the output was never seen.
- `DISABLE_AUTOUPDATER` stopping the launcher swap: not run.
- Contents API live write and token-guard's behaviour on it: not run.
- `routine-new` on a fresh repo: not run.
- Oplify box's real schedule and weekend hours: no AWS access.
- Claude Code features: docs and code only.
- Whether the 64 killed jobs were retried, and whether the OOM kills ended any session's work.
- Ubuntu 22.04 shipping systemd 249 (relevant to `ExitType=`): from memory.
- `api#79`'s origin and HB-* dependency order in epic #199: not read.

## Progress

Updated after every step so another session can continue. Lead: Opus session in founderos worktree `mystifying-lalande-e25ff9`, builders are Sonnet subagents.

Repo facts checked 2026-10-31: neither `claude-agent-setup` (public, `main` unprotected) nor `scripts` (private, `main`) has CI or an AGENTS.md. Base branch `main` in both; PR to `main`. The merge gate is the repo's own test commands run by the lead, with output in the PR, until step 1 adds a CI workflow to `claude-agent-setup`.

| Step | Branch | PR | Proven | Next |
|---|---|---|---|---|
| 0 Plan committed | founderos `docs/tracker-first-routine` | (this PR) | — | step 1 |
| 1 `tracker` tool | — | — | — | dispatch builder |
| 2 Update fix | — | — | — | — |
| 3 `routine-new` | — | — | — | — |
| 4 Lead prompt, skill, hooks, sweep, verdict | — | — | — | — |
| 5 VPS scripts into git, cap, CI slot | — | — | — | — |
| 6 BachelorHouse migration | — | — | — | — |
| 7 Oplify migration | — | — | — | — |
| Exit test | — | — | — | — |

Live state at 15:20 UTC: phone session a8f339fa `idle` (main profile); e1dfd548 `failed`; bh-morning timer inactive; oplify-nightly next 11-01 09:30.
