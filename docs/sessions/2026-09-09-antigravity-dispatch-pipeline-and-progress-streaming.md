# 2026-09-09 — Antigravity Dispatch Pipeline Repair & Telegram Progress Streaming

## What we did

Root-caused why GitHub issues dispatched to Google Antigravity (`agent:ready` label) were never
completing. The failure lived entirely in `~/bin/agent-dispatch`, the VPS cron script (every
15 min) that claims an issue, invokes the headless `agy` CLI, and verifies a PR landed — this
script existed only on the VPS, unversioned in git. It is now checked in at
[deploy/agent-dispatch](../../deploy/agent-dispatch).

Found and fixed four independent, layered bugs in that script, then — at the founder's request —
added live Telegram progress streaming while Antigravity works on a claimed issue, mirroring
[src/gateway/kernel-progress.ts](../../src/gateway/kernel-progress.ts)'s existing pattern for the
kernel's own turns (one placeholder message, edited as the current step changes, deleted at the
end). Found and fixed a real bug in that new code via live testing before calling it done.

## What we fixed

### Bug A — workspace permanently wedged (the primary blocker)
`/opt/agy-workspace/founderos` was stuck on a stale branch (`task/issue-508-...`), 322 commits
behind `origin/main`, with 4 dirty files, unchanged since issue #539 failed on 2026-08-21. Every
`git checkout -B` since then failed with "local changes would be overwritten," and the dispatcher
marked each issue `agent:failed` without ever recovering the workspace — silently killing every
issue from #539 through #667/#668.
**Fix:** `git reset --hard --quiet origin/main && git clean -fdq` immediately before every
checkout (both the fresh-claim and re-dispatch call sites).
**Verified:** clean `Switched to a new branch` with empty `git status --short` on the next real run.

### Bug B — `gh --jq --arg` is not a real flag
`gh`'s `--jq` does not accept jq's own `--arg` sub-flag; passing it produces `accepts 1 arg(s),
received 4` (gh's Cobra parser choking on `--arg`'s leftover tokens). This silently broke
`release_stale_claims()`'s claim-age lookup and `redispatch_unresolved_reviews()`'s review/attempt
lookups since the earliest available logs (2026-08-12) — crash recovery and re-dispatch-after-review
have likely never worked.
**Fix:** `gh ... --json comments | jq -r --arg ...` (pipe through real `jq`, confirmed installed).
**Not yet organically exercised** — no stale claim or unresolved review has existed since the fix.

### Bug C — checkout failure was silent on Telegram
Unlike the sibling "no PR landed" failure path, a checkout failure only posted a GitHub comment,
never notified Telegram — the founder had no way to learn about this failure class from chat.
**Fix:** added the same `notify(...)` call the sibling path already had.

### Bug D — `agy`'s own `--print-timeout` defaults to 5 minutes
Discovered only after Bug A's fix, via a live run that still failed. `agy --print` has its own
internal response-wait timeout (`--print-timeout`, default `5m0s`) completely independent of the
script's outer 30-minute `timeout` wrapper. Any real task exceeding 5 minutes — `pnpm install` +
`pnpm lint` alone can — died with `Error: timeout waiting for response`. Cross-referenced three
occurrences a month apart (#452 2026-08-12, #508 2026-08-18, #670 2026-09-09), all failing at
5m5–6s, never once reaching the 30-minute outer bound.
**Fix:** `--print-timeout $((TIMEOUT_SEC - 120))s` (28 min by default), leaving the outer timeout
as the true backstop with a 2-minute margin.
**Verified:** issue #669 ran 7m33s — past the old 5-minute ceiling — and landed
[PR #671](https://github.com/pushkarverma3698/FounderOS/pull/671) with a real commit.

### New: live progress streaming to Telegram
Founder's ask: the same visibility this session gives him into Claude's own work (narration of
what's happening, not silence until a final result) was missing for Antigravity. `kernel-progress.ts`
already solves this for kernel turns — ported the same shape into bash:
- `agy` now runs backgrounded (`&`) instead of blocking, so the script can poll it.
- One Telegram placeholder is sent at start, then edited (not re-sent) every `PROGRESS_POLL_SEC`
  (default 20s) whenever the tail of the growing `agy` log produces a new distinct line.
- The placeholder is deleted when `agy` exits; the existing pass/fail `notify()` message is
  unchanged and still fires after.
- Both call sites (fresh claim, re-dispatch after review) now share one function
  (`run_agy_with_progress`) instead of duplicating the invocation — the last two bugs above each
  had to be fixed at two separate call sites because the invocation was copy-pasted; this removes
  that failure mode.

**Bug found in the new code, via live testing:** `placeholder_id=$(progress_send ...)` is a command
substitution, which captures *all* stdout produced during that call — including the internal
`log(...)` call's own `printf` to stdout. `placeholder_id` ended up containing the entire log line
plus the real ID concatenated together, not just the ID. Every subsequent `progress_edit`/
`progress_delete` then received a garbled multi-line `message_id`, which Telegram's API almost
certainly rejected (edits/deletes were logged as attempted but very likely silently failed — the
placeholder was observed stuck on "starting…" on the real chat afterward). The actual claim/PR
work was unaffected (progress pings are wrapped to fail silently by design).
**Fix:** moved all `log(...)` calls out of `progress_send`/`progress_edit`/`progress_delete` (which
must stay stdout-clean since their return values are captured) and into the one caller
(`run_agy_with_progress`) that already owns the sequencing.
**Verified two ways:** (1) the earlier buggy run's job-control/polling logic — background, `kill
-0` liveness loop, `wait` for the real exit code — is proven correct independent of the ID bug,
since that same run correctly captured 4 distinct progress labels and still produced
[PR #672](https://github.com/pushkarverma3698/FounderOS/pull/672); (2) after the fix, a standalone
test of the three functions against the real Bot API showed a clean 4-byte numeric ID from
`send`, then real `{"ok":true}` responses from both `edit` and `delete`. The stray stuck
placeholder from the buggy run was manually deleted.

## Why

The founder's original ask was "why aren't tasks completing via Antigravity" — the answer was a
wedged shared workspace that has silently failed every dispatched issue since 2026-08-21, compounded
by two self-healing mechanisms (stale-claim recovery, re-dispatch-after-review) that have likely
never worked since the earliest logs, plus an unrelated CLI default that made *any* real task fail
regardless of the other fixes. All three had to be found and fixed together — fixing only the
workspace would still have died on the 5-minute timeout on the very next real task. The progress-
streaming addition is a direct, minimal-risk port of an already-proven in-product pattern, not a new
design — the only genuine new failure surfaced (the stdout-capture bug) was caught by live-testing
before deploy, not by code review, which is the same lesson Bug D itself taught a few hours earlier.

## Metrics

- 4 dispatch-pipeline bugs found and fixed (A–D), one new-code bug found and fixed via live testing.
- 3 real Antigravity invocations run this session: #670 (first, surfaced Bug D), #669 (7m33s,
  [PR #671](https://github.com/pushkarverma3698/FounderOS/pull/671)), #670 re-run (surfaced the
  progress-streaming bug, still landed [PR #672](https://github.com/pushkarverma3698/FounderOS/pull/672)).
- `deploy/agent-dispatch` now exists in git for the first time — previously VPS-only, unversioned.

## Outstanding

- `deploy/agent-dispatch` is written and deployed live to the VPS, but **not yet committed to
  git** — commits are made only when explicitly requested.
- Bug B (`--jq --arg` fix) and Bug C (missing checkout-failure notify) are fixed and deployed but
  not yet organically exercised — no stale claim or unresolved review has occurred since.
- `TELEGRAM_TESTER_API_ID`/`_API_HASH`/`_SESSION` are now present in prod `.env` (memory previously
  said absent as of 2026-09-07 — that was stale; corrected here).
