# 2026-10-03 — the Telegram `/task` loop repaired end to end, with agy as executor and as reviewer

## What we did

The founder moved the loop from Claude to Antigravity (agy) for both roles, and `/task` stopped working. We audited the VPS logs, his Telegram transcript and the code, fixed every defect in one PR (#794, promoted by #795), deployed, and then ran the real loop through real Telegram.

Result, from the Telegram transcript of 2026-10-02 (times UTC):

| Step | Evidence |
|---|---|
| `/task <plain English>` → "Which repo?" buttons | 20:24:04, #13221 |
| Approval card built from the plain English, then Approve | 20:25:15; issue #796 filed 20:25:33 |
| agent-dispatch claims the issue | 20:26:04, **31 s** after filing (was ~24 min) |
| Antigravity's quota was out | issue back at `agent:ready` with a comment, one pause notice, claimed again at 21:00:04, 3 min after the reset |
| Executor streams into ONE Telegram message | "✅ Antigravity #796 … 2m · 19 tool calls", last five tool calls, "PR #797 opened, draft" |
| PR targets `beta` | #797 base `beta` |
| Reviewer streams into ONE message, on a different model | "Reviewing founderos#797 · 8m · gemini-3.1-pro-high · 63 tool calls" (the Claude models were out for 69 h) |
| Verdict acted on by code | `BRAIN-VERDICT: PASS` → marked ready, marker stamped, squashed into beta 21:28:33 |
| Promotion and close-out | #798 merged to main 21:33:08; issue #796 closed by agent-dispatch 21:30:08 |

Also run live on 2026-10-03 01:17–01:21: `/task repo:FounderOS` naming files that do not exist (card in 8 s, with "Not verified … unverified hints"; on 10-02 this exact request ended "could not be dispatched"), a plain-English request with no `/task` (card in 5 s), and a bare `/task` followed by a reply to the "what should I build" prompt. All three rejected; nothing was filed.

## What we fixed

Eleven defects (full table in #794): invented paths killing the brief lint; the bot spawning `agent-dispatch` under `NoNewPrivileges` (false "agy is not on the PATH" pause after every `/task`, ~24 min to start; now a kick note plus a per-minute cron line); a Claude-only reviewer; PRs for FounderOS targeting `main` (an unreadable workspace read as "no beta"); progress that showed `</app_notification>`; no pattern for agy's real auth error; "Claude reviews" wording with Claude down; merged work listed as "in review"; and three found by running this PR through its own reviewer:

- The plain-text view of an agy run put a ~100-line answer after the error lines, and the failure classifier reads only the last 40. A review that ended on `RESOURCE_EXHAUSTED` was counted as "failed attempt 1/3".
- Quota is per model family on the Antigravity login. `pr-brain` now tries `PR_BRAIN_MODELS` in order (`claude-sonnet-4-6`, then `gemini-3.1-pro-high`), at the preflight and mid-review, never uses the executor's model, and pauses once, naming the models tried.
- `cmd | grep -q` under `pipefail` returned "no match" when grep stopped early and the writer died of SIGPIPE: 125 of 773 tries on a loaded box. It produced a duplicate reviewed marker, and in the sweep's skip check it would re-review a PR whose thread outgrew the 64 KB pipe buffer, every sweep.

And one of my own: a test asked Node for `mkdirSync("/proc/…", {recursive: true})`, which never returns on Linux. It hung CI for 25 minutes, and had stalled my earlier VPS full-suite run and the live review's `pnpm test`.

## Why

`/task` is the founder's way to start work from his phone, and it had stopped producing work. Orchestration stays in FounderOS (one approval card, one queue, code-made verdicts); the work and the review are done by agy.

## Metrics

- Whole suite on Linux: 515 files / 6,816 tests, 278 s. CI on the merged heads: green.
- Claim latency 24 min → 31 s. Executor 2 min / 19 tool calls for a docs task; reviewer 8 min / 63 tool calls.
- Quota, measured: the three non-Gemini models out for 69 h; the Gemini models (reviewer and executor alike) out from about 20:05 to 20:57, so executor and reviewer do compete for one Gemini window.

## Outstanding

- The reviewer cleared a runbook that told the founder to run `agy auth login`, a command that does not exist (`agy --help` lists no such subcommand). Corrected here. A Gemini-Pro reviewer is weaker than the Claude one it replaced while the Claude quota is out; `pr-brain` squash-merges and promotes what it clears on FounderOS. The merge switch is `PR_BRAIN_MERGE=0` on the pr-brain crontab line.
- Not exercised live: the Claude-model reviewer path (quota returns about 2026-10-05 16:48 UTC), a task on an Oplify repo, an executor hitting quota halfway through a run.
- `pr-brain` runs every 20 minutes, so a PR waited 18 minutes for its review (opened 21:02, reviewed 21:20). The executor is kicked within a minute; the reviewer is not.
