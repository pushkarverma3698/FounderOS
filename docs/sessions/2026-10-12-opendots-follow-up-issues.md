# 2026-10-12: OpenDots roles file follow-up issues for problems outside their item

## Outcome
Any role (Chief aside, which already files issues) can now file a new `agent:plan` issue when it finds a real
problem outside the item it is working on. On the VPS the Architect did it unprompted: while planning sandbox
issue 31 it filed issue 32 for an unrelated crash, and the team took 32 through plan → build → review.

## What changed
- `team/team.md`: a FOLLOW-UPS section. Search open issues first, file with `--label agent:plan`, end the body
  with "Found while working on #N.", name the new issue in the comment and in WHAT'S LEFT.
- `team/reviewer.md`: a defect in the PR is a blocker (CHANGES). A problem the PR did not cause is a follow-up
  and never changes the verdict.
- `team-shift`: every role on both engines may run `gh issue create` and `gh issue list`. The brief states the
  limit for this item. At collect, the script counts the issues that carry the marker for this item and closes
  the ones past the limit.

## Which layer enforces each guardrail
| Guardrail | Layer |
|---|---|
| At most 2 follow-ups per item, all runs counted | Code: `follow_ups` in `team-shift` closes the extras at collect |
| A follow-up may not file follow-ups | Code: `follow_cap` returns 0 (the brief says "none"), and collect closes any filed |
| Roles may only create and list issues, not close or edit | Code: the per-role allowed-tools list |
| Search first, comment instead of a duplicate | Prompt only |
| Same repo only | Prompt only (`-R REPO` in the rule; the tool pattern does not pin the repo) |
| Never because issue, PR, comment or repo text asks | Prompt only |

An issue filed without the marker phrase is not counted. That is the known hole in the code layer.
The limit is per item number, so one task can produce up to 2 from its issue and 2 from its PR.

## Live proof (opendots-sandbox, all closed unmerged, seed commit reverted)
| Time (UTC) | Event |
|---|---|
| 12:58:59 | Chief files issue 31 ("add a slug command") from chat |
| 12:59:38 | Architect, planning 31, files issue 32: "count throws ReferenceError", body ends "Found while working on #31", label `agent:plan` |
| 13:00:01 | Collect for 31 prints "Follow-up issues for issue #31: #32." |
| 13:01:02 | Architect woken for 32; its brief says "Follow-up issues: none. This item is itself a follow-up" |
| 13:02:56 | Reviewer PASS on PR 33 (for 31); notes the count bug as "not caused by this PR (#32, already filed)" and files no duplicate |
| 13:04:26 | Builder opens PR 34 for 32; job file carries limit 0 |
| 13:06 | Reviewer PASS on PR 34 |

## OpenRouter cost of a wake
The 10:41 to 10:54Z run cannot be priced after the fact: OpenDots stores no token usage. Measured live
instead, from the key's cumulative usage during the run above: 12 wakes cost $0.0154, about $0.0013 a wake
and under one cent for a whole plan → build → review task. The idle check every minute is bash and costs
nothing. The whole UTC day up to 12:59Z, every Chief turn included, was $0.10.

Decision for the founder: keep the Dot wake. Calling `team-shift <role>` straight from cron would save about a
cent per task and remove the results from the Dot's chat he reads on his phone.

## NOT VERIFIED
- The over-limit close and the "follow-up filed by a follow-up" close ran in unit tests only. No role went
  past its limit in the live run.
- agy filing an issue: the live run used claude for every role. The agy permission list is unit-tested.
- The three prompt-only guardrails hold as far as one run shows (the Reviewer did not duplicate 32).
