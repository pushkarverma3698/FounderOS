# Coding pipeline audit, 2026-10-07

Covers the coding pipeline, the context it runs on, and the Telegram chat for 10-04 to 10-07.

## Result

- Since pipeline v2 was switched on (10-06), 4 tasks went in and 0 merged until 14:12Z on 10-07. On
  10-04 the older, simpler path merged two tasks the same day they were filed (#850, #861).
- The 10-07 task (#972, PR #974) stopped on two code bugs. Both are fixed in PR #982 and proven on
  the real PR: the card now comes out with every check PASS and a merge button.
- Update, 10-07 14:12Z: PR #974 merged into beta as 99c08887 through the real path (Telegram
  evidence card, tap, GitHub squash merge; gateway log "Coding pipeline: merged"). Getting there
  exposed three more seams: an empty `head_ref` on a hand run, a strict beta that strands cards,
  and a token that could not see OplifyMessage. See "What happened after this was written".
- The pattern behind every stall: about 15 hops across 3 Unix users, run by two bash cron daemons
  (`agent-dispatch` 1,543 lines, `pr-brain` 1,471 lines), 1,700 lines of bash helpers and 2,900
  lines of TypeScript. Each hop works out facts again from strings, such as the repo name or the
  diff. The tests run each hop alone or stub the others out, so a mismatch between two hops first
  shows up on a real run, in front of the founder.

## What broke, run by run

| Task | Where it stopped | Root cause | Status |
|---|---|---|---|
| #972, PR #974: `list_issues` returns PRs | pr-brain cleared it 06:54Z; no merge card was sent until 12:52Z, by hand | (1) Contract file is `…__FounderOS__972.json`, pr-brain looks up `…/founderos` (its checkout dir name) and finds nothing. (2) The 56-line locked test that Pass P wrote counted against the executor's 1 file / 20 line limit. | Fixed in #982, on prod 10-07 12:47Z (67204008). Card sent 12:52Z with every check PASS. Merged into beta 14:12Z as 99c08887 |
| Oplify #41 (10-07 10:40) | Bot asked "which repo?" though the message named it, carded the wrong repo, then filed junk issue #83 ("Start work on issue #41") and said an agent had claimed it | The daemons' GitHub token is scoped to `pushkarverma3698` only. `agent-dispatch.log` has 600 "Could not resolve to a Repository" lines for OplifyMessage since 10-06 11:00Z, and nobody was told. The planner never read #41, which PR #81 already fixed on 10-06. | Token swapped by the founder 10-07 13:00 to 13:15Z. Read-before-create: #985, merged 13:22Z. Alert: not built (#987 closed) |
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

The next seam, found while sending #974's card: the merge record pins beta's sha. If anything else
merges into beta before the tap, the tap is refused with "A fresh evidence card follows", but
pr-brain skips a PR it already gated at the same head, so that card never comes. The card text also
does not name the PR it is for. This was read from the code when written, then hit for real: the
first #974 card was refused after beta moved. See the next section.

## What happened after this was written (10-07, up to 14:12Z)

Facts, in order:

1. PR #974 merged into beta at 14:12Z as 99c08887 through the real path: Telegram evidence card, tap
   (Claude sent it through the MTProto tester), GitHub squash merge. Gateway log: "Coding pipeline:
   merged".
2. Bug: `pr-brain --pr N` (a hand run) had an empty `head_ref`, so `ec_issue_of` found no issue and
   the PR silently took the legacy no-card path. Fixed in PR #989.
3. Seam: beta requires branches to be up to date (strict) and CI takes about 7 minutes, so every
   beta merge pushes every other open PR BEHIND. A card is bound to the beta SHA it was made
   against, so the first #974 card was refused after beta moved. `gh pr update-branch 974`, a CI
   rerun and a new card fixed it. PR #988 makes the tap call update-branch, pinned to the reviewed
   head, instead of refusing.
4. The OplifyMessage repos were invisible to the daemons from 10-06 ~11:00Z (fine-grained,
   single-owner PAT) until the founder swapped the token 10-07 13:00 to 13:15Z. At 13:16Z the
   dispatcher picked up Oplify issue #83 and ran spec pass P.
5. Founder decision, 10-07: replace cron and labels with direct runs, in 3 PRs. PR 1 is #990
   (`fos-job.socket`, draft). PR #987 (alert once per unreachable repo) was closed as superseded:
   the founder rejected detect-and-alert patches.
6. Option A or B: the orchestrator chose A on the founder's "use your intelligence" instruction.
   Journey A (`scripts/journey-coding.ts`) already runs a canary on
   `pushkarverma3698/fos-journey-sandbox` every 3 nights from the VPS crontab (`0 3 */3 * *`) and
   was GREEN on 10-04 (PR opened in 2 min) and 10-07 (3 min). B duplicates the direct-run plan.
   Journey A starts at an `agent:ready` issue, not at the Telegram `/task` card, so it does not
   exercise the card or the merge tap; it covers dispatch, agy, PR and CI.

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

## Who is fixing what (as of 10-07, after 14:12Z) and what is still missing

| PR | Fixes | State |
|---|---|---|
| #985 | The planner filed junk Oplify #83 for work PR #81 had already done | Merged to beta 13:22Z, promoted to main by #986 at 13:30Z |
| #988 | The merge card does not name its PR; a beta move before the tap strands the card | Open, draft. The tap calls update-branch pinned to the reviewed head |
| #989 | `pr-brain --pr N` has an empty `head_ref`, so no card is sent | Open, ready for review |
| #990 | PR 1 of 3 of the direct-run plan: one `/task` is one job process via `fos-job.socket` | Open, draft |
| #987 | Alert once per repo the token cannot reach | Closed as superseded by the direct-run plan |

Not covered by any open PR:
1. **Nothing sends merge cards on its own.** pr-brain was turned off by the founder's `/review` at
   10-07 10:40Z (not re-checked since); #974's card was sent by hand. The direct-run plan replaces
   the cron daemons.
2. **Alerts for an unreachable repo.** The token is fixed, but a future 600-line silent failure has
   no alarm. Not built: the founder rejected detect-and-alert patches.
3. **#966/#967** has a spec card from 02:31Z nobody approved, and #967 is blocked after 3 fix attempts.
4. **Canary coverage.** Journey A runs every 3 nights, not after each deploy, and starts at the
   issue, not at `/task`. The card and merge tap have no canary.
5. **Beta moves strand open PRs** until #988 merges. This PR (#984) moves beta when merged.
6. **Stale open PRs**: #923, #963, #970 and #939 sat open on beta as of 13:15Z (not re-checked).
