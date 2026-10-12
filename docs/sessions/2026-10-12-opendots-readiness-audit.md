# 2026-10-12 — OpenDots readiness audit

## What we did
Live-tested the four Dots (Chief, Architect, Builder, Reviewer) the way the founder uses them, through the same
`/api/copilotkit` endpoint the phone app calls (`/tmp/od-say` on the VPS), against `opendots-sandbox` and FounderOS.

| Test | Result |
|---|---|
| Chief: "what is waiting on me?" | 32-42 s, matches GitHub; after the fix it also gives each blocked item's question |
| Chief: "Merge PR 20." right after a status, no repo named | merged into beta, verified on GitHub (failed before the fix) |
| Chief: "close issue 19" | `✓ closed`, verified on GitHub (reported "unreadable action" before the fix) |
| Chief: calendar / email | says honestly it has no access; no MCP connected |
| Builder direct task, claude (#24) | 12 s to start; found slugify existed, ran npm test, blocked with a question |
| Builder direct task, agy (#25) | failing test first, draft PR #27 in ~4 min; Reviewer approved it |
| Chief new work, plan first (#26) | Architect plan, then Builder draft PR #28, through the 15-min cron, no founder step |
| FounderOS suite in the Builder computer | killed (exit 137, 2 GB cgroup OOM) in parallel; passes with one worker in 217 s |

## What we fixed (PR fix/opendots-readiness-audit)
1. team-shift tracked only the clone's fetched branches: the Builder's FounderOS clone was single-branch, so
   `checkout --detach origin/beta` failed under `|| true` and claude would have started on main. Now every branch is
   tracked and a failed checkout blocks the item.
2. `--progress` said only "no run open" once the cron had collected a run into the Shift conversation. It now shows
   how the last run ended (Done block or Blocked lines).
3. chief-run did not know `ACTION closed`. It now checks the issue state on GitHub.
4. chief-run had no memory between turns. The previous turn (under 3 h old) goes into the prompt as context;
   merge() still requires the PR number in the current request.
5. Briefs: blocked items carry their question; the Chief talks to the founder as "you"; every run tests with one
   worker and gets pnpm via `npx -y pnpm@10`.

## Why
The founder wants to leave the laptop. Every fix removes a point where he would have had to open a laptop to find out
what happened (2, 5), repeat himself (4), distrust a correct action (3), or get a wrong-base PR (1).

## Metrics
`pnpm gate` exit 0 on the beta-merged tree: 247 files, 3395 tests. Script suites: team-shift 63, chief-run 29.

## Outstanding
Verdict: ready for daily coding on the founder's own repos from the phone; not ready to drop the laptop. Blockers:
Oplify and turickai repos return 404 (single-owner PAT), no phone notifications, no MCP (calendar/email), the
computers lack the founder's skills and global rules, Oplify production promotion and iOS builds stay laptop-only.
