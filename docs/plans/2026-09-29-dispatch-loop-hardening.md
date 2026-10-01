# Dispatch loop: fail loud, never die silently, one command to add a repo

| | |
|---|---|
| **Branch** | `claude/fix-dispatch-loop-hardening` (base `main` @ `1e797039`) |
| **Executor** | Claude cloud session. No VPS access: the daemons are bash and are tested with fakes on `PATH`, following the pattern in `tests/unit/scripts/agent-dispatch-quota.test.ts`. |
| **Depth** | **Full**: secrets, cron, deploy/infra, and acting on the founder's behalf (GitHub writes). Run all nine stages of `production-ready`. |
| **One of four** | `claude/fix-dispatch-loop-hardening` · `claude/fix-chat-context-truth` · `claude/feat-goals-daily-standup` · `claude/feat-jobhunt-tashi-and-findings`. **Merge this one first**: the goals and jobhunt branches file work into this loop. |

## The founder moment
He files `/task fix X` in Telegram. One of three things happens, and he is always told which:
1. A draft PR appears.
2. The brief is rejected in about 2 seconds, with the exact missing piece, before any tokens are spent.
3. The loop is paused, with the reason (quota, Antigravity login, Claude login, GitHub login) and when it resumes.

Nothing sits at `agent:ready` forever. Adding a new repo to the loop is one command plus a one-line PR.

## Measured facts (2026-09-29)
- **The loop runs mechanically but ships nothing.** `~/.claude/agent-dispatch.log` (8,450 lines, starting 2026-08-11) holds 9 claims.
  - Five were smoke tests: #450, #669, #670, #710 and oplify #57.
  - The one real feature was #762 "Jev AI", written from a brief that named a nonexistent `src/agents/supervisor.ts`. It shipped a fake integration and was reverted in #765.
  - On 2026-09-29 there were **0 open `agent:ready` issues in all 4 repos**. Every tick logs `claims=0`.
- **The prod daemons match the repo byte-for-byte today.** Diffing `~/bin/agent-dispatch` with `deploy/agent-dispatch` and `~/bin/pr-brain` with `deploy/vps-daemons/pr-brain` shows no difference. Deployment is still a manual `scp` (`deploy/vps-daemons/README.md` § "Deploying a change"), and nothing checks for drift.
- **The Gemini key is on the process command line.** `run_agy_with_progress` (`deploy/agent-dispatch:183`) runs `sudo -u antigravity -- bash -lc '<script>' _ "$workspace" "$prompt_file" "$GEMINI_API_KEY"`, so any local user can read the key from `ps` or `/proc/*/cmdline` for the length of each Antigravity run (up to `TIMEOUT_SEC`).
- **Only quota errors are classified.**
  - `quota_reset_epoch` (line 294) handles "Individual quota reached … Resets in 57h37m44s" and re-queues the issue.
  - **Every other failure without a PR goes to `agent:failed`** (line 427): Antigravity auth expiry, an invalid key, `Error: timeout waiting for response` (seen 3 times), `timeout: failed to execute process` (seen once). That state is terminal, so a transient failure kills the issue for good.
- **A startup failure is logged but never sent to Telegram, and repeats every 15 minutes.** This covers `gh auth status` failing, a missing dependency, or `agy` missing for the antigravity user (lines 240–247). The log shows `HTTP 401: Bad credentials` once.
- **pr-brain already handles Claude auth vs usage limit** with `~/.claude/pr-brain.down`: one message when it pauses, one when it resumes (lines 160–217). But an expired Claude login still needs someone to ssh in and run `/login`.
- **A repo is registered in three places, and only two are checked against each other:**
  1. `DISPATCH_REPO_ALLOWLIST` (`src/tools/dispatch-repos.ts:22`).
  2. `DEFAULT_REPOS` (`deploy/agent-dispatch:55`).
  3. `ISSUE_REPOS="…"` inline in the VPS crontab, which **overrides** DEFAULT_REPOS and is invisible to CI.

  `tests/unit/tools/dispatch-repo-serviceability.test.ts` checks only that 1 is a subset of 2. The VPS also needs `/opt/review/<repo>`, `/opt/agy-workspace/<repo>` owned by `antigravity`, and six `agent:*` labels. Each is a manual step.
- The issue template (`.github/ISSUE_TEMPLATE/agent-task.md`) has 9 headings: Goal, Problem / observed behavior, Expected behavior, Evidence, Files or subsystem in scope, Constraints, Explicitly forbidden, Verification commands, Acceptance criteria. **Nothing checks an issue body against it.** `ISSUE-DRIVEN-CONTRACT.md:15` calls it an "intake gate", but it has no mechanism behind it.

## Binding constraint
Every failure that isn't a quota wall has the same outcome: `agent:failed` or a log line. The founder can't tell "broken" from "idle" from "paused". And the one real input it got was a brief nobody checked.

**Strongest argument against:** "The loop has been fixed six times; stop investing and dispatch by hand." Those six fixes were plumbing, and the plumbing works now (quota back-off, lock, attempt cap, progress streaming). What remains is classification and intake, both small pure functions. The goals and jobhunt branches exist to put real work into this loop, which is pointless if a login expiry silently kills that work.

## Scope
1. **Failure classifier (pure bash function plus a table-driven test).** Add `classify_agy_failure <log>`, which echoes `quota | auth | transient | unknown`:
   - **auth:** `401`, `403`, `PERMISSION_DENIED`, `API key not valid`, `UNAUTHENTICATED`, `invalid_grant`, `please log in`, case-insensitive. The issue goes back to `agent:ready`. Write `~/.claude/agent-dispatch.down`, send **one** Telegram message ("Antigravity auth failed: <first matching line>. Fix: <exact command>"), and claim nothing until the down file is removed or the key file's mtime changes.
   - **transient:** `timeout waiting for response`, `ECONNRESET`, `503`, `500`, `UNAVAILABLE`, `timeout: failed to execute process`. The issue goes back to `agent:ready` with a `<!-- agent-transient: N -->` marker. When N reaches 3, it goes to `agent:failed`, which happens today on the first failure.
   - **quota:** unchanged (`quota_reset_epoch`).
   - **unknown:** `agent:failed`, as today.

   Put the patterns in one array at the top of the script and test every pattern against a real log line. The quota lines are in the log; paste them verbatim.
2. **Key off the command line.** Pass `GEMINI_API_KEY` on **stdin**: `as_antigravity 'IFS= read -r GEMINI_API_KEY; export GEMINI_API_KEY; …' <<<"$GEMINI_API_KEY"`. This is the same principle `deploy.yml` uses ("secrets via stdin, never argv"). Test it with a fake `sudo` on `PATH` that records its argv: assert the key never appears there, and that the fake `agy` still receives it in its environment.
3. **Startup failures go loud once.** The `gh` auth, missing dependency and missing `agy` paths all go through the `.down` pattern pr-brain already uses: one Telegram message naming the fix, and silence until it recovers. Share the helper; don't duplicate pr-brain's code. If sharing it across the two scripts is awkward, add `deploy/lib/down-state.sh` and source it from both.
4. **Brief lint in code, at both entry points.**
   - Add `src/tools/agent-brief-lint.ts`, a pure function `lintAgentBrief(body, fileExists)`. It returns `{ ok, missing: string[] }`. It checks the 9 template headings are present and non-empty. It also checks that every backticked path under `src/`, `scripts/`, `deploy/` or `tests/` exists, unless it appears under a heading containing "new file".
   - Wire it into `dispatch_antigravity_task` (`src/tools/dispatch-antigravity.ts:208`, before `issues.create`). For FounderOS, `fileExists` is `fs.existsSync` against the checkout. For the other repos it is `octokit.rest.repos.getContent` on the default branch; a 404 counts as missing.
   - A failed lint files nothing and returns `missing` to the model, so the planner asks the founder for it.
   - The regression fixture is #762's body: it must fail on `src/agents/supervisor.ts`.
   - In the daemon, a cheap claim-time check covers human-filed issues. If any of the 9 headings is missing, apply the label `agent:needs-brief`, comment the missing list, send one Telegram message, and don't claim.
5. **A repo lives in one list, plus a doctor.**
   - Delete `ISSUE_REPOS` from the crontab line, which is part of the founder's VPS steps below, and make `DEFAULT_REPOS` the only list the daemon reads.
   - Extend the serviceability test to check **equality** of `DISPATCH_REPO_ALLOWLIST` and `DEFAULT_REPOS`, not just the subset.
   - Add `deploy/onboard-repo.sh <owner/repo>`, run on the VPS. It is idempotent and prints a checklist it has actually verified. It clones or updates `/opt/review/<name>`, clones `/opt/agy-workspace/<name>` as `antigravity`, and creates the 6 labels with `gh label create --force`. `--check` only reports what is missing for every allowlisted repo. agent-dispatch runs `--check` once per tick, and a missing workspace produces one Telegram message instead of a silent stall.
   - Add `pnpm repo:add <owner/repo>`, a local script that edits both lists and the test fixture, then prints the exact `ssh founderos-vps '~/bin/onboard-repo.sh owner/repo'` line.
6. **New branch in one command.** `pnpm branch:new <type> <slug>` runs `git fetch origin main` and `git switch -c <prefix>/<type>-<slug> origin/main`. Because it starts from **fetched** `origin/main`, never local `main`, it can't reproduce the stale-local-main incident. It then runs `verify:branch`. The prefix comes from `$AGENT_PREFIX` (`claude`, `cursor` or `antigravity`), or is empty for a human.
7. **Daemons deploy with the app.** After the service restart, the deploy step in `.github/workflows/deploy.yml` copies `deploy/agent-dispatch`, `deploy/vps-daemons/pr-brain` and `deploy/onboard-repo.sh` to `~/bin/` atomically (write to `.new`, then `mv`), `chmod +x` them, and compares `sha256sum` against the checkout. A mismatch fails the deploy job. Update the "known gap" paragraph in `deploy/vps-daemons/README.md` to say this is now done.
8. **Claude login that survives weeks.** pr-brain reads `CLAUDE_CODE_OAUTH_TOKEN` from `~/.claude/pr-brain.token` (mode 0600) when that file exists, exporting it into the environment and never passing it as an argument. The founder creates the token once with `claude setup-token`. Record its creation date on a second line of the file and send one Telegram warning after 330 days. Treat the token lifetime as unverified until `claude setup-token --help` on the VPS confirms it.

## Out of scope
- Changing pr-brain's review protocol or re-gating rules (fixed in #766).
- Making Antigravity itself better; that's the brief lint's job.
- The Oplify repos' own CI.

## Edge cases the tests must cover
| Case | Required behaviour |
|---|---|
| Quota wall with no "Resets in" | 1-hour back-off (existing). Keep the test |
| A quota **and** an auth pattern in the same log | Quota wins, because it carries a reset time. Test it explicitly |
| Auth fails while a re-dispatch is in progress (PR exists) | The PR stays open. Only the attempt is not counted, and the `.down` file is written |
| Key rotated while paused | The key file's mtime changes, the down state clears, and one "resumed" message is sent |
| Transient failure 3 times | `agent:failed` with all 3 log tails in one comment |
| The founder removes `agent:working` mid-run | The run finishes, and the relabel sees the label already changed. No crash. Log it |
| Issue closed mid-run | The PR still opens as a draft. The notification says the issue is closed |
| VPS reboot mid-run | The stale lock and stale claim marker are recovered by the existing lease path. Assert it still works |
| Telegram API down | `notify` failures never change dispatch state (existing `|| true`). Keep it that way |
| `onboard-repo.sh` run twice | Second run makes no changes and exits 0 |
| Brief lint: path in a fenced code block, not backticks | Not checked (documented limit). Test that it doesn't false-fail |
| Brief lint: GitHub API 5xx while checking paths | Lint returns `ok` with a warning line. **The loop's job is to not block on its own infra**; only a definite 404 fails |

## Verification
- `pnpm gate`: N/N pass, 0 skipped, counts shown. `bash -n` passes on every changed script. Run `shellcheck` if it's available.
- **Real-path assertions (after merge, on the VPS):**
  1. `~/bin/agent-dispatch --list` works, and the `sha256sum` of `~/bin/*` matches the merged `main`.
  2. `ps -eo args | grep -c "$(cut -c1-12 <<<"$GEMINI_API_KEY")"` returns **0** during a live Antigravity run.
  3. `~/bin/onboard-repo.sh --check` prints 4 green repos.
  4. `/task` a deliberately bad brief in Telegram. It is rejected, listing the missing headings, and no issue is created.
- **NOT VERIFIED from the cloud session:** every VPS step above, which Claude on the laptop or the VPS runs after merge.

## Founder action after merge (about 10 minutes)
1. `ssh founderos-vps 'crontab -e'`, then delete the `ISSUE_REPOS="…"` part of the agent-dispatch line.
2. `ssh -t founderos-vps 'claude setup-token'`, and paste the token into `~/.claude/pr-brain.token` (then `chmod 600`).
3. Rotate the Gemini key. It has been readable from `ps` during every Antigravity run; the gap was first recorded 2026-09-22. Put the new key into `/opt/founderos/.env` and the GitHub secret.
