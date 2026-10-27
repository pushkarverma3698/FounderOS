# Simplify the agent workflow: routines, verdict, VPS, brain

**Status:** Draft, waiting on founder decisions D1–D3 (2026-10-27)
**Replaces:** nothing yet. Once merged, it supersedes the open "batch review vs add A" choice from the 2026-10-27 review-strategy session.

## Result

Keep the workflow and change the plumbing underneath it. The nightly loop works when it runs: timer, one lead session, builders, review, merge of the reviewed SHA, code-only verdict. Oplify's timer run on 10-27 finished clean in 18 minutes. Most of the hand-built plumbing exists to work around three causes. Fixing those removes the workarounds:

1. **The worktree fence** refused 27–39% of builder commands on 10-26, and half of the Definition of Done is rules for rewriting commands around it. A session started inside a worktree that our script creates has no fence. Tested on 10-27; see below.
2. **Three Pro accounts** (the smallest paid plan) run an Opus-led multi-agent job. bh-morning hits the usage limit on almost every run. Account failover, the resume timer, WIP rescue and the duplicate-session bug all come from this.
3. **No version control** for the scripts and job files. That left 54 `.bak` copies, a laptop copy older than the VPS, and fixes that broke earlier fixes.

## Where we are (measured 2026-10-27)

| Area | Measured | Source |
|---|---|---|
| bh-morning runs 10-24..27 | 0 timer-fired runs finished unaided. Every productive run was a manual start. 10-26 03:04 failed "workspace not trusted". 10-27 03:04 never fired because the timer was stopped and re-armed. | journal, PR timestamps |
| oplify-nightly | 10-27 timer run done in 18 min: api#79 merged, promotion draft #195 opened | journal, gh |
| Usage limit | 3 blocks on alt2 in 2 days. `claude auth status`: main, alt and alt2 are all `subscriptionType: pro`. alt2 at 97% of its session at 12:31 UTC. | VPS |
| Worktree fence | 27–39% of builder calls refused on 10-26. Test 10-27: a `--bg` session started in a `git worktree add` folder, without `-w`, ran `cd X && git status`, `X=…; git -C "$X" log` and `git log \| head` with no refusal (`1OK 2OK 3OK`, session 5b9804b3, alt2, Haiku). | docs `worktrees.md`, `agent-view.md` "How file edits are isolated"; test |
| Resume timer | Fired about 9 times. 1 useful resume (10-27 11:17), 1 duplicate session (10-27 00:17, since patched). | journal |
| WIP rescue | 15 saves, 0 restores. Some saves held only `node_modules`. | `routine-wip/*` refs |
| RAM reaper | 55 job kills since 10-25, including a `git push` (feat/t140) and two `git commit`s mid-run. eslint uses 1.1–1.5 GB per process inside a 4.5 GB slice. | reaper journal |
| Disk | `/` at 92% (6.2 GB free). About 14 GB is dead weight: `/opt/agy-workspace` 3.8G, `/home/antigravity` 3.4G, `/opt/review` 3.0G, review-bh 3.7G. Removing them takes `/` from 66G to about 52G of 75G (about 70%). | `df`, `du` |
| Drift | VPS `routine-verdict` is 361 lines (md5 4bbd…), laptop 334 (709a…). `claude-routine` and the pr-digest prompt also differ. Running `setup-claude-routines` today would roll prod back. | md5 |
| Copies | 54 `.bak/.staged/.installed` files (41 VPS, 13 laptop). Job files edited 6–8 times in 3 days. | find |
| Verdict | 5 runs, never printed "all ready". 10-27 09:30 fired while bh was paused at the limit and reported 4/12. | journal |
| PASS marker | 9 markers, all posted by the account that authored and merged the PR. It records which SHA the lead reviewed. It adds no independence. | gh |
| Remote Control | 12 `claude-remote@` servers (3 accounts × 4 folders), about 700 MB RAM. Use is visible only on `main` (hypothesis: transcripts go back only to 10-26). | systemd, reaper log |
| Dead since 10-10 | `fos-job.socket`, `agy-login.socket`, `/home/founderos/bin` (agent-dispatch, pr-brain), `brain-mcp.mjs`, minio. On the laptop: `agent-dispatch`, `pr-brain`, `agy`, router scripts, `brain-auto-ingest.sh`, `context-check.py`, launchd `omniroute` (exits 78). | infra audit |
| Brain | `brain_memories` 2,679 rows: ACTIVE 919, ARCHIVED 1,504, SUPERSEDED 256. Search and sync already skip non-ACTIVE rows (`chunkPlan`, `scripts/sync-turicks-brain.ts:81`). `knowledge_entries` 1,470 rows (249 current), written on every sync with one Ollama embed per changed doc (`sync-turicks-brain.ts:502-619`). Its 3 query functions plus `getTuricksBrainCount` have 0 callers (`src/db/queries.ts:1036-1156`). `turicks_brain` 1,352 rows, frozen, read by nothing (`sync-turicks-brain.ts:10`). `research_cache` 2,429 rows, last write 2026-10-09, no writer or reader left: both `searchBrain` callers pass `brain_memories` (`src/mcp/brain-tools.ts:117`, `scripts/brain-recall-check.ts:101`). | `docker exec founderos-postgres psql` (read-only, 10-27), grep |
| brain-sync on 10-27 | 9 runs, 5 red: 3 recall check at 9/10 against a baseline of 10 (`governance/brain-recall-golden.json`), 2 Ollama unreachable or timed out on the VPS. Latest run green. | `gh run list`, `--log-failed` |

## Decisions for the founder

- **D1. Review: "batch review" or "add A"?** Recommended: batch review, and only at the promotion PR. The lead already reviews every PR before merging it: diff, red/green proof, CI. A second reviewer per PR ("add A") repeats that on accounts that already hit the limit. The gap is edge cases, and those matter at the point code reaches prod. Oplify: the run that opens the beta→production promotion PR runs the code-review plugin on the promotion diff, and systematic-debugging proves each finding with a failing test before it counts. BH has no production branch yet, so it gets the same step when it does.
- **D2. Do you use the phone servers on the alt and alt2 accounts?** If not, 8 of the 12 Remote Control servers go (about 450 MB RAM). Phone coding stays on `main`. The routines still use the alt/alt2 background daemons, so those stay either way.
- **D3. Accounts: no decision now.** Measure first. T3 removes the refused-and-retried calls, which should cut usage. If bh still hits the limit on 2 of its next 3 runs, choose: lead on Sonnet (no extra cost) or one Max account (costs more per month, and deletes the failover code).

## Target

Same loop: `timer → claude-routine (pick account, create worktree, launch one --bg lead) → lead picks tasks, builders in their own worktrees, lead reviews and merges the reviewed SHA → report ending "Needs you: N" → code-only verdict → one Telegram`.

KEEP: systemd timers, the account probe and failover (worked 10-26 10:11), `claude-notify`, the code-only verdict, DoD hard rules 1–6, `founder-actions.md`, the print-mode digest, the slice memory caps, `session-brief`, `guard-bash.sh`.

## Tasks (in order; each ends with its proof)

1. **One source of truth (30 min, no behaviour change).** Pull the 3 drifted files from the VPS to the laptop. Put `~/Projects/scripts` under git with a private GitHub remote, with the job files under `routines/jobs/` (`founder-actions.md` stays on the VPS: it is runtime state). Turn the heredocs in `setup-claude-routines` into real files it copies. Delete all 54 copies.
   Proof: an md5 of every installed file equals git HEAD. `find` shows 0 `.bak*` files in those directories.
2. **Disk and dead infra (1 h).** Delete everything in the "Dead since 10-10" row, `/opt/agy-workspace`, `/home/antigravity`, `/opt/review/*`, `/opt/founderos-qa` and review-bh, each after `grep -r <path> /etc/systemd /usr/local/bin` shows no live unit or script uses it. The `~/work` clones stay (phone coding). Point `claude-clutter-clean` at `/opt/review`. Remove the npm-global `/usr/bin/claude` (`/usr/lib/node_modules/@anthropic-ai/claude-code`, 2.1.287) so PATH gives the same build the daemons run (2.1.308).
   Proof: `df /` ≤ 80%. `systemctl list-units` shows no fos-job or agy-login. The next routine run is green.
3. **Remove the fence (2 h plus one real run of each routine).** `claude-routine` runs `git worktree add ~/work/wt/<routine> -B <branch> origin/<base>` at a fixed path per routine (one trust entry per account), trusts it, and launches `claude --bg` there without `-w`. The lead gives each builder its own `git worktree add` folder instead of `isolation: worktree`. Cut DoD "Shell rules" from 5 rules to 2 (stay in your worktree, never touch the shared clone). Drop the docker `npm ci` route if a plain `npm ci` works in the builder's worktree. `claude-routine` removes the worktree at the start of the next run, so nothing is left behind.
   Proof: on the next bh and oplify runs, 0 transcript lines with "isolated in the worktree", and PRs merge as before.
4. **The RAM guard stops killing work (1 h).** Builders run eslint/tsc through `flock ~/.cache/heavy-check.lock`, one heavy check at a time. The reaper never kills `git`. Age kills and idle stops stay.
   Proof: the next run has 0 git kills and fewer eslint kills than today's 24.
5. **Resume and rescue (1 h).** Set `CLAUDE_CODE_RETRY_WATCHDOG=1` in the `claude-bgd@` unit. The docs say unattended sessions then wait out the usage window themselves. If a limit-hit `--bg` run continues on its own after the reset, delete the resume timer. If it does not, keep the timer (it is patched and worked on 10-27). Delete WIP rescue either way, because builders push after every commit (DoD §5).
   Proof: one limit-hit run finishes with no `[routine-resume` marker.
6. **Verdict (1 h).** The lead sets a commit status (`context=routine/review`) on the reviewed SHA instead of the hidden comment. The verdict reads it from `statusCheckRollup`, so a later push drops it by itself. If the run is still going, the verdict says "still running, resumes ~HH:MM" instead of a partial NO. Message fixed at 3 lines plus a count.
   Proof: run the verdict on today's PRs and show the Telegram text for a finished and an unfinished run.
7. **Job files (1 h, after T3).** Drop the fence rewrites, state the Telegram wording once (bh-morning says it 3 times), and add one Haiku step that reads the last merged PRs and review comments touching the same files (context-gathering gap from the 10-27 review). Target: bh-morning ≤ 80 lines, DoD ≤ 60.
   Proof: the next run of each routine is green with the shorter files.
8. **Brain slice (repo PR, Antigravity: `docs/antigravity/AG-067-brain-sync-slim.md`).** The sync stops writing `knowledge_entries`, which removes one Ollama call per changed doc and the `--keyword-only` mode, the only thing that mode did. Delete the 4 query functions nothing calls. The recall baseline drops from 10 to 8, so one brittle case stops turning brain-sync red; misses still print. Dropping the three dead tables (`knowledge_entries`, `turicks_brain`, `research_cache`: 5,251 rows, none read) and narrowing `ALLOWED_RAG_TABLES` is a separate Full-depth step after a `pg_dump`, a week after the PR merges. The merged recall check and session brief from #1239's plan stay.
   Proof: `pnpm gate` green, `brain-sync.yml` green, the same top-1 result for 5 `search_memory` queries before and after.
9. **After D1 and D2.** Install the code-review plugin for the agent account. Add the promotion-review step to oplify-nightly. Stop the 8 unused Remote Control servers if D2 says so.

T1 comes first because every later task edits the same files. T2 and T8 are independent of the rest. T3 before T7.

## Exit criteria

- 3 timer-fired runs in a row of bh-morning and of oplify-nightly finish with a "Needs you" line and no manual restart.
- 0 fence refusals and 0 reaper kills of `git` across those runs.
- Every installed script and job file matches git HEAD, checked by `verify-agent-setup`.
- The verdict prints "all ready" on a day every PR passes, and "still running" while a run is paused.
- Disk ≤ 80%.
- Line count of `claude-routine` + `routine-verdict` + `setup-claude-routines` + job files + DoD falls from 1,639 today (223 + 361 + 620 + 126 + 114 + 89 + 106 for `routine-new`) to under 1,000.

## Strongest argument against

T3 changes the one path that just started working. The fence also kept agents out of the shared clone: without it, a builder that `cd`s into `~/work/<repo>` can edit or reset the checkout every routine branches from. On 10-27 at 05:43 two builders already collided in a shared worktree. Mitigations: every agent gets its own worktree path; `claude-routine` refuses to start if `git -C <clone> status --porcelain` is not empty, so a dirtied clone stops the next run instead of spreading; the lead checks `git worktree list` before merging. (The 15-minute fetch timer only fetches; it does not reset the clone.) If the risk is not worth it, T3 can stop after the lead session (no `-w`) and keep `isolation: worktree` for builders. That still removes the fence from the lead, which runs the review and merge commands.

The other argument: one Max account would delete more code than T3–T5 combined. That costs money, which is why it is D3 and not a task.

## NOT VERIFIED

- Whether `CLAUDE_CODE_RETRY_WATCHDOG` applies to `--bg` sessions. The docs cover unattended sessions but do not name `--bg`. T5 tests it.
- Builders working in a lead-created `git worktree add` folder: the 10-27 test covered a top-level session only.
- A plain `npm ci` in a builder's own worktree without docker.
- A commit status from `gh api …/statuses` showing in `statusCheckRollup` on a private Free-plan repo.
- Whether alt/alt2 Remote Control servers are used: transcripts go back only to 10-26.
- How much of the usage burn is the Opus lead and how much is fence retries: no per-session token numbers.
- Readers of the three dead tables outside this repo (another repo, a VPS cron). AG-067 step 1 checks the VPS.
- Why Ollama was unreachable at 06:06 and 06:32 UTC on 10-27 (two red brain-sync runs). Hypothesis: the RAM reaper or memory pressure; T4 should show it.
