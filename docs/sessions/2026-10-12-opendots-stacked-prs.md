# 2026-10-12: OpenDots runs a multi-part task as stacked PRs

## Outcome
A multi-part task now runs to the end with no founder step until the merges. Before, part two stalled because
its code was only in part one's unmerged PR (sandbox issues 35-39, PR 40). PR: FounderOS 1142 (draft, to beta).

## What changed
- `team/architect.md`: a dependent child carries `Builds on: #<issue>`.
- `team-shift`: a child whose dependency has no PR yet waits in `agent:build` and is not handed out. Once the
  dependency has an open PR, the Builder branches from that PR's head and opens its PR onto that branch. The
  Reviewer reviews against that base and prints the merge order on PASS. A blocked child with a `Builds on:`
  line returns to `agent:build` once when its dependency is ready. The scan retries once on a GitHub error.
- `shift-cron`: a failing check wakes the paid Dot only on the 3rd failure in a row.
- `chief-run merge`: refuses a PR whose base PR is still open; retargets onto beta once the one underneath
  merged. Still founder-named and `agent:approved` only. No role got merge permission.
- `shift-notify`: the Reviewer's Done message carries the merge-order line.

## Which layer enforces each guardrail
| Guardrail | Layer |
|---|---|
| A child is not built before its dependency has a PR | Code: `dep_state` in `team-shift` |
| Merges go in stack order | Code: `chief-run merge` (only when the founder merges through the Chief) |
| A blocked child is requeued once, not in a loop | Code: marker comment checked by the scan |
| No paid wake for one bad GitHub answer | Code: `FAIL_WAKE=3` in `shift-cron` |
| The Architect writes the `Builds on:` line | Prompt only |

## Strongest argument against, stated before building
Later parts are built on code nobody has reviewed. A rejected part A can invalidate B-D, and the merges must
go in order.

## Live proof (opendots-sandbox)
| Time (UTC) | Event |
|---|---|
| 13:45 | Task sent to the Chief; Architect opens epic 41 and children 42-45 (43 on 42, 44 on 43, 45 on 44) |
| 13:59 | PRs 46 (to beta), 47, 48, 49 stacked on each other, all `agent:approved`, no founder step |
| 13:59 | Reviewer result ends "Merge order, first to last: #46 (approved), #47 (approved), #48 (approved), #49 (approved)." |
| later | Chief refuses "merge PR 47" ("Merge 46 first"), then merges all four into beta in order |
| 14:03 | Issue 50 (`agent:blocked`, builds on 45) requeued by the check; PR 51 approved 14:06 |
| 14:13 | Computer restarting: "failed check 1 of 3 in a row, no wake yet"; 14:14 back to "No work" |

Installed by hand: `/opt/opendots/deploy`, `install.sh` (image c470bdc4), four computers restarted through the API.

## NOT VERIFIED
- The GitHub HTML-error retry against a real GitHub error (unit tests with the fake gh only).
- The merge-order line in a real Telegram message (unit test only).

## Known gaps
- A circular or never-built `Builds on:` waits forever; it shows only as `Waiting:` in the cron log.
- Merging a stack with the GitHub button instead of the Chief lands in the other PR's branch.
- Sandbox issues do not close on a merge to a non-default branch.
- The three `chief-run` stack tests were written after the code.
