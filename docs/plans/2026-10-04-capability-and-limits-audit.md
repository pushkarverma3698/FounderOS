# FounderOS capability and limits audit — 2026-10-04

**Companion to:** [2026-10-04 Telegram UX audit](2026-10-04-telegram-ux-audit.md) (PR #827). That
audit covers what the founder *reads*. This one covers what the system *can do for him*, and what
stops a small input from producing a large result.

## 0. The result in five lines

1. FounderOS is built wide, but people use it narrowly. In 30 days, every real side effect was coding
   (31 rows in `action_log`). No email, post, calendar event or job application went through it.
2. Money is not the limit. The model bill for 7 days was **$0.17**. The limits are attention
   (approvals, pings, waiting) and the last step: merging, applying, sending.
3. The coding loop produces work that doesn't land. Agents opened 13 PRs in 7 days. FounderOS merged
   4; Oplify merged **0 of 6**, and 3 are still open.
4. The job loop screens without converting. **4,307** jobs were screened, and **2** were applied to.
5. The biggest gains come from changing defaults and removing taps, not from adding features. Fifteen
   tasks are listed below; the top five are each one PR.

## 1. What FounderOS is for (intent)

The founder states an outcome in one Telegram line. FounderOS turns it into finished work, such as a
merged PR, a sent application or a scheduled post, with proof attached. The founder spends seconds
deciding, not minutes operating. Two measures follow from that:

- **Leverage** = outcome size ÷ founder seconds spent.
- **Trust** = how often he acts on a reply without opening GitHub, the sheet or the VPS to check.

Every limit below is scored by which of the two it costs.

## 2. Measured state (prod DB + GitHub, read-only, 2026-10-04)

| Signal | Value | Window | Source |
|---|---|---|---|
| Kernel turns | 51 | 7 d | `agents.agent_results` |
| Turn latency p50 / p95 | 17.4 s / 79.6 s | 7 d | `agent_results.latency_ms` |
| LLM spend | $0.17, 340 calls, all on one model | 7 d | `agents.ai_call_costs` |
| Distinct tools used | 17, of ~70 tool modules in `src/tools/` | 7 d | `agent_results.tools_used` |
| Side effects recorded | 31: 23 dispatches, 4 workflow runs, 3 claude_code, 1 requeue | 30 d | `agents.action_log` |
| Approval cards | 89: 74 approved, 14 rejected, 1 expired | 30 d | `agents.hitl_approvals` |
| Time to decide a card | under 1 minute on average (approved and rejected) | 30 d | `resolved_at − created_at` |
| Jobs screened → applied | Pushkar 3,809 → 2 · Tashi 498 → 0 | all time | `agents.job_applications.stage` |
| Agent PRs opened / merged | FounderOS 7 / 4 · Oplify API 6 / 0 (3 open) · Oplify app 0 / 0 | 7 d | `gh pr list head:task/` |
| Missions (multi-day goals) | 5 rows | all time | `agents.missions` |

What the table means:
- **Approval is a reflex, not a check.** 83% of cards are approved in under a minute. A gate that
  always says yes costs a tap and adds no safety. The 14 rejections are the useful signal, and AG-021
  (#828) now renders them as "Dropped".
- **Tool breadth is unused.** Email, LinkedIn, calendar, video, image and browser tools are all wired,
  but none of them ran in 7 days. Either the founder doesn't know they exist, or he doesn't trust
  them enough to ask.
- **Waiting is the real cost.** A 17 s median turn is fine for a question. It is too slow to give
  "do it" feeling, and the 80 s p95 breaks the conversation. The 2026-09-28 perf audit traced most
  of that time to Gemini thinking.

## 3. Where a small change gives a large result (leverage map)

Each row is something the system already can do, the change that unlocks it, and the effect.

| # | Already built | Small change | Effect for the founder |
|---|---|---|---|
| L1 | The job screen ranks 4,307 roles | The daily brief offers **one** role with a pre-tailored CV and a single "Apply" button; the tailored docs already exist (`tailor_status`, `tailored_cv_s3_key`) | Applying goes from never to one tap a day. Outcome C moves for the first time. |
| L2 | agent-dispatch turns an issue into a PR in ~30 min | `/task` writes the 9-section brief itself (`dispatch-brief-repair.ts` exists) and adds `agent:ready`, so no hand-written issue | One sentence becomes a PR. Today an incomplete brief is refused (this session's #828 sat unclaimed until it was rewritten). |
| L3 | pr-brain reviews every agent PR | A green review on a non-frozen, Lite-depth PR merges to `beta` automatically, and the founder gets one evening digest (the 30-day `PR_BRAIN_MERGE=0` stays the switch) | PRs land. Oplify's 0/6 is a merge bottleneck, not a coding one. |
| L4 | 22 HITL-gated tools | Approve a **class** once ("dispatches to my own repos", "workflow runs") with a daily cap and a `/undo` card; keep per-action approval for anything that leaves the building (email, posts, applications) | Fewer than half the taps; the remaining cards mean something. |
| L5 | The planner already returns a typed Plan | Send a 1-line "on it — 3 steps, ~2 min" ack within 2 s, then the result. Use the fast model with no thinking for routing | The wait feels like work happening. p50 perception drops from 17 s to 2 s. |

## 4. Limits, by type

Every limit names what enforces it. If nothing does, it says "nothing", following rule #27.

### 4.1 Capability limits: the system cannot do it

1. **It can't apply to a job.** The loop ends at "screened" plus a draft. Submitting a form is a
   founder action (and ATS portals need a login and CAPTCHAs), so applications must stay
   founder-performed. The fix is to shrink his part to one tap that opens the prefilled page, not to
   automate the submit. Enforced by: design, and the safety rules.
2. **It can't merge without the founder.** `PR_BRAIN_MERGE=0` by founder decision until end of day.
   Every PR waits a day at least. Enforced by: an env flag on the VPS.
3. **A plan has at most 8 steps** (`MAX_PLAN_STEPS`, `src/kernel/contracts.ts:177`). Large goals
   must become a mission, and there are only 5 mission rows ever. Multi-day work has no visible home.
   Enforced by: Zod in CI.
4. **One agent claim per repo per tick, 30-minute timeout** (`MAX_CLAIMS=1`, 1800 s in
   `deploy/agent-dispatch`). That is at most 4 tasks an hour per repo, serially. Fine today, but a
   ceiling once L2 makes tasks cheap. Enforced by: daemon config.
5. **Dispatch covers only 5 repos** (`DEFAULT_REPOS`, `deploy/agent-dispatch:113`). A new project
   needs a code change and deploy before agents can touch it. Enforced by: daemon code.

### 4.2 Friction limits: it can, but using it costs too much

1. **The approval tax:** 89 cards in 30 days, decided by reflex (§2). Enforced by: `hitlGate()` per
   tool, which is correct for external sends and too blunt for internal ones.
2. **The brief tax:** a `/task` issue needs nine filled sections, or the dispatcher refuses it
   (`AGENT_BRIEF_HEADINGS`). That protects quality, but the founder writes one line. The system,
   not the founder, should fill the template.
3. **The wait tax:** a 17 s median and 80 s p95, with no progress shown in a normal turn.
4. **The discovery tax:** about 50 commands and about 70 tool modules, but the founder uses roughly
   17 tools. Nothing tells him what it can do *for the thing he's doing now*.
5. **The noise tax:** 75% of what he reads is machine status (UX audit §2). He learns to skim, then
   misses the one message that needs him.

### 4.3 Trust limits: it did it, but he can't rely on it

1. "✓ verified" under failures, which AG-021 (#828) is fixing.
2. Tashi's brief commands act on the wrong queue, and the NOT LAWFUL label misleads (AG-020, waiting
   for the unfreeze).
3. No single "what happened today" view across coding, jobs and ops. `/where` covers coding only.
4. Agent PRs say "done" before a human has run them; the PR template's NOT VERIFIED is the only
   brake. Enforced by: the review culture plus pr-brain.

### 4.4 Platform and operating limits

1. **One model for everything.** All 340 calls went to `gemini-3.6-flash`. The cost is fine. The risk
   is that one provider outage or rename stops every lane, as the 10-03 model rename showed for
   pr-brain. Enforced by: the model policy (`.claude/rules/model-policy.md`).
2. **Logins expire.** Google OAuth and the Claude login on the VPS expire, and each expiry pauses a
   lane until the founder re-authenticates. 80 restart/sign-in messages in 7 days (UX audit). There
   is no advance warning ("expires in 3 days").
3. **The 30-day freeze** (until 11-01) blocks `src/tools/jobhunt/` and `mac-client/` without the
   `unfreeze` label. That's intended, but it also blocks the highest-leverage fix (L1). The founder
   must decide explicitly.
4. **The Mac client is a single point of failure** for job pings and local work. When the laptop
   sleeps, that lane stops quietly.
5. **400-line file cap and tombstones.** These keep the code healthy and slow nothing the founder
   sees. Listed only so nobody blames them.

## 5. Task list (ranked by founder impact ÷ effort)

### P0: one PR each, changes the outcome numbers

| ID | Task | Moves | Frozen? | Evidence |
|---|---|---|---|---|
| C-P0-1 | **Apply-one-today card**: the brief's first row carries the tailored CV + cover letter links and a "✅ I applied" button that sets `stage=applied` | C | yes, `src/tools/jobhunt/` | 4,307 → 2 |
| C-P0-2 | **`/task` writes the brief**: run the brief repair/lint on the founder's sentence, post the filled brief for one 👍, then add `agent:ready` | A | no | #828 sat unclaimed with an incomplete brief |
| C-P0-3 | **Instant ack**: under 2 s, "On it: <plan title>, N steps", edited in place with progress | A | no | p50 17.4 s, p95 79.6 s |
| C-P0-4 | **Evening digest replaces per-event pr-brain pings**: one message, a numbered list of PRs ready to merge, each with a merge button | A, B | no | 259 pr-brain/dispatch messages in 7 d; 0/6 Oplify merges |
| C-P0-5 | **Login expiry warning**: warn 3 days before Google/Claude auth expires, with the exact command | B | no | 80 restart/sign-in messages in 7 d |

### P1: removes a recurring tax

| ID | Task | Moves |
|---|---|---|
| C-P1-1 | Standing approvals by class with a daily cap and `/undo`, internal actions only (dispatch to own repos, workflow runs) | A |
| C-P1-2 | Auto-merge to `beta` on a green pr-brain review for Lite, non-frozen PRs, behind the existing `PR_BRAIN_MERGE` switch. Founder decision required | A |
| C-P1-3 | `/today`: one screen across coding, jobs and ops. Three lines, each with one button | B |
| C-P1-4 | Contextual "you can also…" hint: after a reply, suggest one unused tool relevant to it, at most once a day | D |
| C-P1-5 | Second model as an automatic fallback for planner and synthesizer, so a provider outage degrades instead of stopping | D |

### P2: raises a ceiling, do after P0/P1 show use

| ID | Task |
|---|---|
| C-P2-1 | Dispatch repos from config, so adding a repo needs no deploy |
| C-P2-2 | Missions surfaced in `/today` as multi-day goals with progress |
| C-P2-3 | Raise `MAX_CLAIMS` to 2 per repo once C-P0-2 makes tasks cheap and review keeps up |
| C-P2-4 | A Mac-client heartbeat in `/today` ("laptop lane: asleep since 14:02") |
| C-P2-5 | Monthly "unused capability" review: drop or surface every tool with 0 calls in 30 d |

## 6. The strongest argument against this plan

"Fix use before adding power" assumes the founder *wants* to delegate email, posts and applications.
The 7-day data can't tell "doesn't know it can" from "doesn't want it to". C-P1-4 tests that cheaply
before anything is built for those lanes. Ask before building.

### 6.1 Decision: email and posts (2026-10-04)

Question: should FounderOS send email and posts for the founder, or do coding work only?

**Decision: coding work only until 2026-11-01. The email and LinkedIn tools stay as they are:
built, approval-gated, not extended and not promoted.** Revisit on 11-01 with the re-measure in §7.

Why, from the all-time `agents.action_log` (111 rows, read on the prod DB 2026-10-04):

| Action | Count | First | Last |
|---|---|---|---|
| `send_email` | 6 | 2026-06-13 | 2026-06-16 |
| `linkedin_post` | 6 | 2026-06-16 | 2026-08-11 |
| `dispatch_antigravity_task` + `claude_code` + `run_shell` | 63 | 2026-06-13 | 2026-10-03 |

1. He tried both lanes early and stopped: email ran 6 times in 4 days and never again; posts ran 6
   times and none in the 54 days since 08-11. That reads as "tried it, didn't keep it", not "didn't
   know it existed". Surfacing hints (C-P1-4) would push a lane he already walked away from.
2. The 10-02 freeze, which the founder approved, limits work to outcomes A to D until 11-01. Email and
   posts are none of them, so any new work on those lanes needs an explicit `unfreeze`.
3. Both tools already carry a per-action approval card, so nothing is sent without a tap. No
   safety change is needed to leave them as they are.

What this changes in the task list: C-P1-4 stays, but its hint pool excludes `send_email`,
`linkedin_post` and `schedule_social_post` until the founder reverses this decision. Nothing in
§5 builds for those lanes.

**Reversible by one line from the founder** ("enable email and posts"): then email and posts get a
brief of their own, scoped to one lane at a time, with an `unfreeze` label.

## 7. How we'll know it worked (re-measure 2026-11-01)

1. Applications: 2 → at least 20 (C-P0-1).
2. Agent PRs merged ÷ opened: 4/13 → above 70% (C-P0-4, C-P1-2).
3. Approval cards per week: about 21 → below 10, with the rejection share rising (C-P1-1).
4. Perceived wait: time to first bot message under 2 s for 95% of turns (C-P0-3).
5. Distinct tools used per 7 d: 17 → 22, with no new tools added (C-P1-4).

## NOT VERIFIED

- "~70 tool modules" counts files in `src/tools/` (plus `jobhunt/` and `browser/`), not registered tools.
- "About 50 commands" counts files in `src/gateway/`, not registered command handlers.
- 7-day latency comes from 51 kernel rows only. Job and dispatch daemons don't write
  `agent_results`, so their timing is not included.
- The reason for 0 Oplify merges (review quality vs founder bandwidth vs red CI) was not traced per
  PR; C-P0-4 assumes bandwidth.
- No code was changed or run; every task is a hypothesis until its PR shows output.
