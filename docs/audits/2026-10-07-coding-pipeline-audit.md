# Coding pipeline audit, 2026-10-07

Covers the coding pipeline, the context it runs on, and the Telegram chat for 10-04 to 10-07.

## Result

- Since pipeline v2 was switched on (10-06), 4 tasks went in and 0 merged. On 10-04 the older,
  simpler path merged two tasks the same day they were filed (#850, #861).
- The 10-07 task (#972, PR #974) stopped on two code bugs. Both are fixed in PR #982 and proven on
  the real PR: the card now comes out with every check PASS and a merge button.
- The pattern behind every stall: about 15 hops across 3 Unix users, run by two bash cron daemons
  (`agent-dispatch` 1,543 lines, `pr-brain` 1,471 lines), 1,700 lines of bash helpers and 2,900
  lines of TypeScript. Each hop works out facts again from strings, such as the repo name or the
  diff. The tests run each hop alone or stub the others out, so a mismatch between two hops first
  shows up on a real run, in front of the founder.

## What broke, run by run

| Task | Where it stopped | Root cause | Status |
|---|---|---|---|
| #972, PR #974: `list_issues` returns PRs | pr-brain cleared it 06:54Z; no merge card was ever sent | (1) Contract file is `…__FounderOS__972.json`, pr-brain looks up `…/founderos` (its checkout dir name) and finds nothing. (2) The 56-line locked test that Pass P wrote counted against the executor's 1 file / 20 line limit. | Fixed in #982, on prod 10-07 12:47Z (67204008). Card sent 12:52Z with every check PASS; waiting for the founder's tap |
| Oplify #41 (10-07 10:40) | Bot asked "which repo?" though the message named it, carded the wrong repo, then filed junk issue #83 ("Start work on issue #41") and said an agent had claimed it | The daemons' GitHub token is scoped to `pushkarverma3698` only. `agent-dispatch.log` has 600 "Could not resolve to a Repository" lines for OplifyMessage since 10-06 11:00Z, and nobody was told. The planner never read #41, which PR #81 already fixed on 10-06. | Token: founder. Alert and read-before-create: not built |
| #966, `/goal` fix | PR #967 hit 3 review-fix attempts and was blocked. A new spec card went out 10-07 02:31Z and was never approved. | Vague free-text brief on the old path | Waiting on the spec card, or close it |
| #956 | 403 on the token, then the test already passed (fixed earlier by #834), then the executor made 0 commits | No fail-first check at the time | Closed. #968 now stops this case before a card goes out. |

Other chat failures in the window:
- 10-06 17:25: a cleanup ran out of tool calls (6 allowed). Raised to 15 for read steps by #979.
- 10-04: wrong answers to "what did I just ask you".
- `/tasks` said "pr-brain is reviewing it" for #972 4h25m after the review had cleared it.

## Why the fixes keep not working

1. **No test runs the real hops together.** The offline chain test used one repo string at every
   hop and stubbed the evidence verdict, so CI was green while the chain was broken. #982 makes the
   chain test spell the repo the way pr-brain does; it fails on the old code (4 of 6 tests).
2. **"Done" stopped at deploy.** Sessions merged, deployed, and left the first real `/task` to the
   founder ("only the founder's /task full-flow run is left"). The founder became the integration
   test, and each run found the next seam.
3. **State crosses processes as strings.** The repo name comes from GitHub in Pass P and from a
   directory name in pr-brain. Nothing carries one typed record from start to merge.
4. **Failures are quiet.** 600 unreachable-repo errors and not one message. #974 was cleared, but
   the founder got only "Merge: not attempted — PR_BRAIN_MERGE=0, a human merges", with no button.

The next seam, found while sending #974's card (read from the code, not yet run): the merge record
pins beta's sha. If anything else merges into beta before the tap, the tap is refused with "A fresh
evidence card follows", but pr-brain skips a PR it already gated at the same head, so that card
never comes. The card text also does not name the PR it is for.

## Options for "replace it with simple LangGraph nodes"

**A. Canary first (about 1 day).** A small `/task` on a sandbox repo runs through the real daemons
after every deploy and once a night, with a known one-line bug. When any hop stalls past its time
limit, Telegram gets a message naming that hop. This keeps the current code and stops the founder
being the test. It does not reduce the number of hops.

**B. LangGraph coding graph (your goal, about 3 to 5 days, done in stages).** One graph in the
kernel:

```
intake → spec → [approve] → execute → verify → [merge] → merge → deploy check
```

Typed state carries the repo (GitHub's own spelling), the contract, the PR and the head sha. The
Postgres checkpointer and `interrupt()` already exist for the two founder taps. The agy run stays
one external call, and the cron daemons shrink to a trigger. One CI test drives the real graph with
only GitHub, the model and agy mocked, which catches the seam bugs above.

The strongest argument against B is that it rewrites a chain that is one fix away from working.
For 3 to 5 days nothing gets better, and new code brings new seams.

**My view:** build A now. Then move to B one hop at a time, starting with verify → merge (the hop
that failed today), and judge each step by whether the canary stays green.
