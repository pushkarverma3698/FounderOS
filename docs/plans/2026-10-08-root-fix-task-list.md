# Root-fix task list (2026-10-08)

The founder asked: go through the prod Telegram chat, show why FounderOS can't do simple work, collect the earlier fixes,
and list everything needed to switch to FounderOS for daily work, with Telegram as the front end.

This plan builds on two plans and doesn't repeat them:
[understanding plan](2026-10-07-understanding-plan.md) (AG-030..038) and the daily-driver plan in PR #1002 (AG-039..044).
It adds AG-045..049 and changes one gate (AG-038). Links to AG-039..043 resolve once PR #1002 merges.

## Verdict

FounderOS fails for three reasons.

1. **The cheapest models do all the thinking.** Prod runs `gemini-3.6-flash` for the planner and `inclusionai/ling-3.0-flash`
   for every worker and the synthesizer (`agents.ai_call_costs`, last 30 h, about $0.21 total). The founder compares it with
   Claude Code on his laptop, which runs Opus or Sonnet.
2. **Three model calls per turn, each with partial context.** Plan, then worker, then synthesizer. Each one sees a slice of
   the conversation. Regex guards were added to stop the weak models from making things up. Those guards now cause most of
   the visible failures (examples below).
3. **The plumbing reports state it does not have.** Pipeline status reads GitHub labels, not whether the job ran. Gmail and
   Calendar have been down since the token expired. The bot does not know that `main` is prod.

217 PRs merged to beta since 09-01 and 11 audit or plan documents in three weeks. Only about 15 of those PRs touched
understanding. Each patch fixes one symptom and the next guard adds another. The root fix is one strong model running one
loop over the whole conversation, with tools. That is AG-038, which is gated today. This plan proposes to un-gate it once a
cheap baseline run has been recorded.

## Evidence from the prod chat

### 10-07 evening, 21:25 to 22:10: 2 of 10 asks answered correctly

| Time | Founder asked | What happened | Cause |
| --- | --- | --- | --- |
| 21:25 | What was merged today | Listed open PRs #1002, #997, #984, #970 as merged, then added a false "delivery requested" notice | Weak synthesizer; `verify.ts` file regex |
| 21:34 | Find the agent-factory draft | Found it | ✓ |
| 21:34, 21:35, 21:36 | What does it state? | The file was read (266 lines) three times, but no answer came back | `verify.ts:19` treats any objective containing "file" as a CSV export and fails the step. The repeat guard (90 s, per thread) then blocked the next turn's read and told the model "the result is in the conversation above", which wasn't true. One retry guessed a path that doesn't exist. |
| 21:38 | Create an issue | Brief lint rejected it twice. Result: two issues (#1004, #1005) and two approval cards | Lint vs. planner mismatch |
| 21:38:48 | Where are we stuck and failing? | Never answered | An approval card was waiting. `turn-gates.ts:35` replied "Not started… send your message again". He approved 3 s later and the question was gone |
| 21:40–22:01 | Status of #1005 | "Spec being drafted" for 30 minutes | The spec job had exited 1 on "You've hit your weekly limit · resets Oct 11". Status reads labels, not the job |
| 21:5x | Test that agy is available | Gave task status instead of a check | Planner misread the ask |
| 21:5x | Dispatch with the heavy model | Model choice ignored | `/engine` does not reach the spec stage (`src/tools/pipeline-spec.ts` always runs Claude) |
| 22:02 | Why is it stuck | Found the weekly-limit cause | ✓ |

### Earlier, same pattern

- 10-04: "what did I just ask you a minute ago?" failed three times in a row.
- 10-06 17:25: a cleanup ask hit the 6-call cap and closed nothing.
- 10-07 10:42 to 13:39, Oplify issue #41: three different answers. First "needs a label", then "already dispatched", then
  "already resolved via PR #81". PR #81 had merged on 10-06 09:35, so only the last answer was right.
- 10-07 16:28 "what shipped to prod today": said nothing, although #981, #986, #992 and #998 were promoted to main.
- 10-07 16:33 open PRs: listed the merged #996 as open.
- 10-07 21:05 "what is on my calendar tomorrow?": "I only have a tool to create events."
- 10-07 21:32 "how do I add a goal and have FounderOS work on it until it's done?": offered a /goal button. He asked for
  autonomous pursuit of a goal.
- 10-07 22:01 /tasks showed Oplify instead of FounderOS.
- "Tool budget reached (3 calls)" repeats on action steps. "Worker did not finalize with JSON" repeats in failure lessons.

### The grading misses this

- The judge (`answer_evaluations`) gave an average of 95 for groundedness and 98 for relevance over 107 turns in 7 days.
  It checks whether the answer matches the tool output, not whether it answered the question.
- The 10-07 hand-grade of 189 turns ([queue/context audit](2026-10-07-queue-context-tools-audit.md)) found 72% OK and 67%
  on follow-ups.
- The AG-030 golden set (15 cases) is merged and has never had a live run. All four configs in the PR #991 A/B table are
  NOT VERIFIED.

## Earlier fixes, grouped (beta, 09-01 to 10-08)

| Area | PRs | Count (approx.) | Did it converge? |
| --- | --- | --- | --- |
| Coding pipeline, deploy, dispatch, pr-brain, merge cards | #990 #989 #988 #985 #982 #968 #942–944 #926 #913–918 #818 #804 #794 #766 #721 #716 #674 #673 #635 … | 42 | Partly. One full `/task` run worked (#995). It still breaks on quota and on labels drifting from job state. |
| Understanding (planner, kernel, brain context) | #1000 #979 #978 #976 #975 #963 #961 #959 #921 #911 #877 #875 #862 #846 #833 | 15 | No. Each fixed one turn type. No run measured the total before or after. |
| Gateway and Telegram UX | #950 #949 #899 #894 #893 #887 #826 #825 #824 #813 #808 | 11 | Mostly yes. |
| Infra (boot, health, restarts, ffmpeg) | #995 #977 #958 #945 #891 #889 #871 | 7 | Yes. AG-037 fixed the restart root cause. |
| Brain and memory | #964 #962 #904 #749 #743 #741 | 6 | Yes for storage. It is still not used well at answer time. |
| Jobhunt | about 21 PRs | 21 | Separate track, frozen until 11-01. |

The rest are docs, tests and chores. The work went where the founder felt the pain: about three times as many PRs went into
pipeline plumbing as into understanding, and understanding is what makes the chat usable.

## Task list

Depth follows the repo rule: Full for kernel, pipeline, auth and anything that acts on the founder's behalf. "Size" is
build days for one agent. **New** means a brief in this PR; the others link to existing briefs.

### Wave 0: stop the false failures (this week, about 3 days, all Lite except AG-047)

| # | Task | Depth | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1 | **[AG-045](../antigravity/AG-045-drop-file-keyword-deliverable-check.md) (new)** Delete the "file" keyword check in `verify.ts`. Require a file only when the plan sets a typed `deliverable` field | Lite | 0.5 | none |
| 2 | **[AG-046](../antigravity/AG-046-repeat-guard-per-step.md) (new)** Scope the `github_read` and `read_logs` repeat guards to one step envelope instead of thread + 90 s | Lite | 0.5 | none |
| 3 | **[AG-047](../antigravity/AG-047-held-message-runs-after-approval.md) (new)** A message held behind an approval card runs by itself once the card is approved or rejected, instead of "send your message again" | Full | 1 | none |
| 4 | Google re-auth (founder, 2 minutes), then AG-044 calendar read | Full | 1 | re-auth |
| 5 | One live `pnpm eval --suite understanding` on the current prod config: the baseline every later change is measured against | n/a | 0.1 | none |

### Wave 1: one brain (next week, about 5 days)

| # | Task | Depth | Size | Depends on |
| --- | --- | --- | --- | --- |
| 6 | [AG-031](../antigravity/AG-031-model-truth-and-strong-model-ab.md) part 2 (PR #991): A/B with a strong model on the golden set, Gemini Pro now and Sonnet after the quota resets on 10-11 | Full | 1 | task 5 |
| 7 | [AG-038](../antigravity/AG-038-single-agent-conversation-loop.md): one strong-model loop for read and think turns. **Gate change:** build it if task 6 shows the strong model beats the baseline by 10 points or more, no longer "only if below 85% after AG-032/033" | Full | 3 | task 6, founder decision 1 |
| 8 | [AG-032](../antigravity/AG-032-founder-working-memory-block.md) working memory, folded into the AG-038 prompt rather than built into the old planner | Full | 1 | AG-038 |
| 9 | Remove the guards AG-038 makes redundant: the progress guard, the cross-turn repeat guards, and the 3-call action budget. Each removal needs its own golden-set case | Lite | 1 | AG-038 on prod |

[AG-033](../antigravity/AG-033-follow-up-referents.md) (follow-up referents) is closed unbuilt if AG-038 ships, because one
loop over the whole conversation resolves "it" and "that" without a resolver.

### Wave 2: the coding loop without the laptop (PR #1002, about 5 days)

| # | Task | Depth | Size | Depends on |
| --- | --- | --- | --- | --- |
| 10 | [AG-039](../antigravity/AG-039-one-token-one-repo-list.md) one token, one repo list | Full | 1 | none |
| 11 | [AG-040](../antigravity/AG-040-job-file-replaces-labels.md) a job file replaces labels, so status reads what the job did | Full | 2 | AG-039 |
| 12 | **[AG-048](../antigravity/AG-048-spec-stage-follows-engine.md) (new)** The spec stage follows `/engine`, and an exhausted quota becomes a Telegram message within a minute instead of 30 minutes of "drafting" | Full | 1 | AG-040 |
| 13 | [AG-041](../antigravity/AG-041-promote-from-telegram.md) promote and deploy-check from Telegram, plus "what shipped to prod" read from `main` | Full | 1 | none |

### Wave 3: daily life off the laptop (about 4 days)

| # | Task | Depth | Size | Depends on |
| --- | --- | --- | --- | --- |
| 14 | AG-044 calendar read; Gmail read via the same Google account | Full | 1 | task 4 |
| 15 | **[AG-049](../antigravity/AG-049-mac-bridge.md) (new)** Mac bridge: from Telegram, read a Mac file, list a folder, take a screenshot, and run an approved command on the Mac. Outbound-only agent on the Mac, every write gated | Full | 2 | founder decision 3 |
| 16 | [AG-042](../antigravity/AG-042-native-tools-in-the-hub.md) FounderOS read tools in the VPS hub | Full | 1 | none |
| 17 | Goals that run until done: `/goal` creates a goal, a daily job picks the next step, asks for approval, and reports progress. Brief written after AG-038 ships, because it needs the new loop | Full | 3 | AG-038 |

### Wave 4: keep it honest (ongoing)

| # | Task | Depth | Size | Depends on |
| --- | --- | --- | --- | --- |
| 18 | [AG-036](../antigravity/AG-036-judge-scores-understanding.md) the judge scores "answered the question", and a re-ask within 5 minutes counts as a fail | Lite | 1 | none |
| 19 | Weekly: the golden set runs once in CI (paid, about $1) and its score is posted to Telegram on Monday | Lite | 0.5 | task 5 |

Total: about 17 build days, 4 to 5 weeks at the current pace. Waves 0 and 1 change what the founder feels. The rest is
reach.

## The switch-over checklist

The founder can stop opening the laptop for a job when its row is green on prod.

| Daily job | Today | Green after |
| --- | --- | --- |
| Ask about my repos, PRs, what shipped | Wrong about 1 in 3 times | Wave 0 + AG-038 + AG-041 |
| Follow-up questions ("what does it state?") | 67% | AG-038 |
| Start a coding task and see it to merge | Worked once (#995); breaks on quota or labels | AG-039, 040, 048 |
| Promote and deploy | Laptop | AG-041 |
| Calendar and email | Down (Google token) | Re-auth + AG-044 |
| Something on the Mac (a file, a screenshot, a command) | Not possible | AG-049 |
| A goal FounderOS keeps working on | Not possible | Task 17 |

## Strongest argument against this plan (#25)

AG-038 replaces the core loop, and the old design exists for a reason: per-step receipts, typed failures, and HITL. A
single loop could regress those guarantees.

The answer is that the guarantees live in the tools, not in the planner. `hitlGate()` is inline in each side-effecting tool
and receipts are recorded in code, so a new loop calling the same tools keeps both. AG-038 keeps the old graph for
action turns until the golden set shows the loop handles them.

The second argument is cost. A Sonnet-class model on every turn is about 10 to 30 times the current $0.17 a day, so roughly
$2 to $5 a day. That is an estimate from list prices, NOT VERIFIED. Task 6 measures the real cost before it ships.

## In-flight work this displaces (#30)

- AG-033 is likely closed unbuilt (see Wave 1).
- AG-032 moves from the old planner into the AG-038 prompt.
- The merge order in PR #1002 stays; Wave 0 runs in parallel because it touches different files.

## Founder decisions needed

1. Un-gate AG-038 on "beats the baseline by 10 points" instead of "below 85% after AG-032/033". Recommended: yes.
2. A model budget of up to $5 a day for the strong model on prod. Recommended: yes, capped by `daily-budget.ts`.
3. The Mac bridge needs the Mac awake and an agent running on it, outbound only. OK to install it? Recommended: yes, read
   actions first.

## NOT VERIFIED

- That the founder saw the "Not started" reply at 21:38:49. The code path and the missing `turn.out` are in the prod log; the Telegram message itself was not read back.
- The strong-model cost estimate ($2 to $5 a day). It comes from list prices, not a run.
- The 10-point gate for AG-038 is a proposal. No run exists yet to set it from.
- PR counts per area come from title keywords in 217 merged PRs and are approximate (±5).
