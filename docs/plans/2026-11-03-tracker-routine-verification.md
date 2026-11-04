# Tracker-first routine: verification checklist

**Status:** Open. This is the single list of what is left before the setup counts as READY and reusable.
**Verdict today:** READY except C3 (the phone path, running now).

A box gets ticked only with evidence: the command plus its output, or a PR/run link.

## A. Installed and proven (done, 2026-11-03)
- [x] claude-agent-setup #10, #11, #12, #14, #15, #16 merged; scripts #48, #50, #51 merged.
- [x] Split token-guard installed on the laptop and the VPS; `test-token-guard.sh` exit 0; a test `ls` exits 0 through the hook on both machines.
- [x] `sync-agent-rules --check`: laptop and VPS match (88 files).
- [x] `routine-new --dry-run` prints WOULD STOP for an unprotected or uncovered repo.

## B. End-to-end proof (done, 2026-11-03, from VPS journal + tracker history)
- [x] B1. bh-morning timer active (`claude-routine@bh-morning.timer`, 08:34 Asia/Kolkata) plus the hourly `routine-sweep.timer`.
- [x] B2. oplify-api timer active (15:00 Asia/Kolkata = 09:30 UTC; a leftover 19:50 UTC verify drop-in was removed). oplify-app stays PAUSED=1.
- [x] B3. Timer-fired run, no manual start: `routine-sweep` backgrounded run 70ed6eb1 at 2026-11-02 20:17 UTC; it ran `tracker next`, claimed T-151 and opened bachelor-house-backend #114 (merged). Tracker row: Run 70ed6eb1, Branch feat/t151-listing-detail, PR #114.
- [x] B4. Live run is never duplicated: slots at 03:04 (timer), 03:17 and 04:17 (sweep) logged "slot skipped, bh-morning run 70ed6eb1 is still working". The next run, 7ddae503 at 05:17, claimed a different task (T-138) and blocked it with a founder question.
- [x] B5. Collision-free: builders of one run claimed T-240, T-162 and T-243 within 9 minutes, each on its own branch; oplify-api (19:50) and bh-morning (20:17) ran at the same time on separate repos. The 06:17 sweep resumed exactly those three leftovers (run 4f549e02).
- [x] B6. `routine-verdict@bh` (09:30 UTC) and `routine-verdict@oplify` (17:30 UTC) fire daily on their timers and count the routine PRs (oplify: 1/7 on 11-02 17:30, 7/9 on 11-03 06:13).

## C. Pending: reusable everywhere
- [x] C1. New repo: `routine-new` onboarded a fresh private repo end to end: beta, tracker, VPS clone, job file, conf, guard policy on both machines, timer installed paused. Branch protection is refused by GitHub on a free private repo, so that step needs `--allow-unprotected`. A real run armed the timer at once, so `--paused` was added in claude-agent-setup #19 (draft, CI pending). Cleanup checked: no probe conf or timer left on the VPS.
- [x] C2. Fresh machine: README laptop install (claude-agent-setup #18) run as-is in an empty HOME from `main`: hooks + token_guard + skill installed; `ls` exit 0, push to main BLOCKED exit 2. Follow-up: `guard-bash.sh` now lives in the repo too; sync-agent-rules still installs the private copy, so the two can drift.
- [ ] C3. Phone: a Remote Control session started from the phone can run `work the tracker` on a repo and reach a PR.
- [x] C4. Public repo audit: one hit (a private task-file name in the token-guard block message) removed in claude-agent-setup #17; re-grep clean; installed hook re-synced (88 files match).

## D. Founder decisions (not verification)
- [x] D1. Kept worktrees: merged ones removed; scripts #52 (bh-morning PAUSED=0, matches live VPS) merged. Left: linkedin-growth-engine `claude/write-confirm-precheck-d2c69a` (11-file conflict in send code, needs a rebase decision); 2 kept bh-morning worktrees on the VPS with work not on GitHub.
- [x] D2. FounderOS PRs: 15 → 2 open. 11 merged to beta (incl. #1237), #991/#997/#1007 closed (kernel gone). Left: #1168 (patch conflict), #1265 (this plan). oplify-messaging-api #188 needs the `no-test-needed` label.
- [x] D3. tracker-cas-scratch is gone (`gh repo delete` → 404; no scratch repo in the account list).

## Owner
- C3: founder (phone run started 2026-11-03).
