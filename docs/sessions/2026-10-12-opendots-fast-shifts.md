# 2026-10-12: OpenDots small tasks take minutes, not an hour

## Outcome
A small task sent to the Chief went plan → build → review in 13 minutes on the VPS (about 7 without one
OpenDots 502). The same kind of task took 50 minutes before. PR #1136.

## Root cause
The work was never slow. The shift clock ran every 15 minutes, so each of the four hand-offs
(Chief → Architect → Builder → Reviewer → done) waited up to 15 minutes. The 20-repo change from #1133 also
made the free idle check take 25 to 52 s of its 60 s timeout, because it asked GitHub once per repo and label.

## What changed
- `team-shift`: the queue scan is one GraphQL call for all repos and labels (1.4 to 2.3 s on the real 20 repos).
- `shift-cron`: runs every minute under a lock. The same Due line wakes its Dot again after 2 minutes, then
  every 15, so a Dot that cannot clear a job costs 4 paid turns an hour, not 60.
- The Architect now falls back to agy when claude hits its usage limit, like the Builder and Reviewer.

## Live proof (sandbox issue 29 → PR 30, both closed unmerged)
| Time (UTC) | Event |
|---|---|
| 10:40:35 | Chief files the issue from chat |
| 10:41:02 | Architect woken; claude hits its limit, agy takes over at 10:42 |
| 10:45:23 | Plan posted: "small, one PR, base beta" |
| 10:46:04 | Builder woken; the wake dies on an OpenDots 502 |
| 10:52:05 | Builder woken again; PR 30 opened 10:52:53 |
| 10:53:42 | Reviewer verdict PASS, label `agent:approved` |

The 502 at 10:46 held the Builder for 6 minutes under the first version of the guard. That is why the
2-minute retry exists.

## Gotchas
- `docker cp` puts the new `team-shift` in the running computers only. Rebuild the image with `install.sh`
  after a merge, then stop and start each computer through the API.
- A wake can fail inside OpenDots after the POST returns 200 ("Intelligence platform error 502",
  "Thread lock denied"). The cron cannot see that; the retry covers it.

## NOT VERIFIED
- A small task on a repo with a slow test suite. Wait time is now minutes; the suite's own run time is on top.
