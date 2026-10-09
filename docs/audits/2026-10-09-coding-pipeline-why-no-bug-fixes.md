# Why the Telegram coding pipeline fixes no Oplify bugs (2026-10-09)

Sources: VPS journal and `~/.claude/agent-dispatch.log` / `pr-brain.log` (10-06 → 10-09), `agents.conversation_turns`
(194 founder turns since 10-06), the last 400 PRs on both repos, Oplify issues #83–#120.

## Verdict

The pipeline does fix small FounderOS bugs: #974, #995, #967, #850, #797, #833 and #834 merged with agy-only commits.
It cannot fix an Oplify bug today. Since the spec stage (pass P) went live on 10-06, Oplify asks #83, #115, #117
and #119 produced 0 merges. Four code defects cause this. More PRs will not fix them, and neither will prompt patches.

## Root causes (all four seen in today's run)

1. **Pass P is hard-wired to FounderOS's test setup.**
   - The locked test is always vitest under `tests/unit/*.test.ts` (`deploy/lib/pass-p.sh:56,186,193`), and the
     fail-first check runs vitest (`pass-p.sh:439-490`).
   - Oplify API CI runs `node --test "test/**/*.test.js"`, so the locked test never runs in CI.
   - pr-brain blocked #116, #118 and #120 for exactly this reason.
   - The executor prompt requires `pnpm verify:arch` (`src/tools/executor-prompt.ts:83`), a script Oplify does not have.
   - `pass-p.sh:174` and #1115 add "do NOT use Vitest" to the prompt while the runner still requires vitest.
   - The 10-06 thin-slice plan deferred the node:test adapter and the repo Capability Contract, and the pipeline was
     pointed at Oplify anyway.
2. **The worker never sees the founder's words.**
   - `founder_request` ("verbatim") is filled with the planner's step text. Issue #117 shows "Pick the first open
     issue found in s1 and dispatch Google A…", and agy then built an "s1 dispatcher module" (PR #118).
   - The duplicate check `parseIssueReference` (`src/agents/agent-tools/antigravity.ts:97`) scans only
     `founder_request` and `title`. It does not scan `goal`, so "Fix issue #115" in the goal missed the check, and
     #117 and #119 were filed as duplicates of #115.
   - This is the same bug class as 10-07, when #41 became #83.
3. **The issue → spec → card chain does not bind.**
   - The /task "fix the most priority issue" became #119. That issue points at #117 (P3), although Oplify has
     9 P1 issues.
   - The spec writer then produced a billing test (phantom ₹0 mandate payment) that matches no issue. The closest is
     #99 (refunds, P3).
   - The card did not show the mismatch, and it was approved at 14:54 UTC.
4. **Fix rounds do not refresh the PR body.**
   - Round 2 rewrote the test into `test/phantom-payment.test.js` (node:test), but the PR body still showed the
     round-1 vitest output.
   - pr-brain called that body "fabricated" and blocked #120. pr-brain was switched off at 16:01 UTC.
   - #1115 (sync the title) patches only part of this.
   - The integration tests skip without a DB, although `oplify-messaging-api-postgres-1` runs on the VPS.

## Walls on top (state at 17:35 UTC)

1. Claude weekly limit: `agent-dispatch.claude-blocked`, resets Oct 11 00:00 UTC. It burned FounderOS asks #1004,
   #1005 and #1030 before the agy fallback shipped (#1098/#1100).
2. agy quota: `agent-dispatch.quota-until` = 1791569429 (10-09 ~18:10 UTC).
3. pr-brain off: `~/.claude/pr-brain.off`, written by the founder's /review at 16:01 UTC.

## Throughput

- 285 PRs since 09-30: 72 promotions (25%) and 73 that touch the pipeline itself.
- About 10.7k lines of pipeline code (5.5k bash, about 5.1k TS) for "run a CLI on an issue, open a PR".

## Other prod noise since 10-06 (level ≥ 50)

| Count | Error |
|---|---|
| 122 | provider-probe "credential expired or revoked" (turicks/naggar Google) |
| 71 | LangSmith telemetry REFUSED |
| 23 | tool:github Not Found (wrong repo or PR lookups) |
| 15 | scheduler profile-lane failures |
| 14 | turn.error, mostly TimeoutError on 10-08 21:31 and 10-09 02:32 |

## Fix order (smallest first)

1. Pass P reads the target repo's test command from its `package.json` / CI. It writes the locked test in that runner
   and path, and runs fail-first with it. The executor's verify command comes from the same source. Failing test
   first: a node:test fixture repo.
2. Pass the founder's raw message through to `founder_request`, and run `parseIssueReference` over `goal`, `problem`
   and `evidence` too. Failing test first: goal "Fix issue #115" must queue #115 and file nothing new.
3. The spec card shows the target issue's title next to the spec's `expected_behavior`. When the spec names no
   target issue, it refuses.
4. Regenerate the PR body (test output and file list) after every fix round.
5. Then turn pr-brain back on and rerun Oplify #115 once, end to end.

## NOT VERIFIED

- Whether laptop Claude sessions draw on the same weekly pool as the VPS pipeline token.
- Whether PR #120's billing fix is correct. pr-brain says it "appears functionally correct", but it matches no issue.
- The 13:13 and 14:31 turns are missing from `conversation_turns`. The turn writer runs one turn late; the cause is
  not traced.
