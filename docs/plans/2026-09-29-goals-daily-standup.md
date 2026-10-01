# Goals with a daily standup, run by deterministic code

| | |
|---|---|
| **Branch** | `claude/feat-goals-daily-standup` (base `main` @ `1e797039`) |
| **Executor** | Claude cloud session. No VPS or prod DB access. |
| **Depth** | **Full**: new schema and migration, plus a cron. Run all nine stages of `production-ready`. |
| **One of four** | `claude/fix-dispatch-loop-hardening` · `claude/fix-chat-context-truth` · `claude/feat-goals-daily-standup` · `claude/feat-jobhunt-tashi-and-findings`. Merge after dispatch and context. **This is the only branch of the four that adds a migration**, so there is no numbering race. |

## The founder moment
He sends `/goal add Tashi applies to 5 NL roles a week | metric=applications_7d:wife-nl-finance target=5 by=2026-10-31`.

Every morning at 09:00 his time, one Telegram message arrives:

```
Standup · Tue 30 Sep
1. Tashi 5 NL applications/week: 0 of 5 (need 5 more by 31 Oct, pace BEHIND) [Plan next step]
2. Dispatch loop ships 1 merged fix/week: 1 of 1 ✓ on track
Blocked: none
```

The morning message makes **zero LLM calls**. Only when he taps **Plan next step** does a kernel turn run. It proposes 1–3 concrete actions, and any side effect (for example filing an `agent:ready` issue) goes through the normal approval card.

This is how an engineering team works: goals, a daily standup, work handed to engineers (Antigravity), review (pr-brain), and progress measured from real events.

## Measured facts (2026-09-29)
- **The pieces already exist:**
  - `schedule_task` (`src/agents/agent-tools/scheduling.ts:40`, HITL-gated) queues future kernel turns. Its table `agents.scheduled_tasks` has `prompt, scheduled_at, status, attempts, idempotency_key, recurrence`.
  - `runScheduledTaskSweep` runs every minute (`src/infra/scheduler.ts:221`, wired at `src/index.ts:105`).
  - The table has **21 rows, the last created 2026-07-21**, so it has been unused since then.
- **Why not use `schedule_task` for the daily check:** a scheduled task runs a full LLM kernel turn every day. On 2026-08-21 the founder switched off "paid crons producing no acted-on output" (`src/infra/scheduler.ts:15`). A daily standup has to be cheaper than that. So the check is plain code, and the LLM only runs when he asks for it.
- **There is no goal object anywhere.** `mission.goal` in kernel state (`src/kernel/state.ts`) is the goal of a single turn and disappears when the turn ends.
- **Deterministic metric sources that exist in prod:**
  - `agents.job_applications.applied_at` and `profile_id`. Prod values: `pushkar-nl-tech` has 2 applied ever, `wife-nl-finance` has **0 applied** and 62 actionable NL rows in 30 days.
  - `agents.action_log`: one row per successful external action.
  - GitHub, through the Octokit already used in `src/tools/dispatch-antigravity.ts`: merged PRs and closed issues per repo.
- `appTimeZone()` exists and reminders already use it (`src/tools/reminder.ts:68`). The existing `cron.schedule("0 9 * * *")` calls in `scheduler.ts` pass **no timezone**. Pass `{ timezone: appTimeZone() }` for the standup, and don't change the others in this branch.
- `schema.ts` is 1,808 lines and `queries.ts` 2,323. Both are already over the 400-line budget, which the ratchet counts per file. Put the new code in new files, the same pattern as `src/db/ats-cache-queries.ts` on the unmerged `antigravity/feat-ats-pipeline-scale` branch. The latest migration on `main` is `drizzle/0041_fresh_viewed_at.sql`.

## Binding constraint
Progress has to come from real events, not from what the model says. A goal is only as good as the metric the code computes for it.

**Strongest argument against:** "Store goals in `founder_context` and let the planner review them." That puts judging progress back in the model, which is the exact failure class this repo was rebuilt to remove. It also has no history, so "behind pace" can't be computed.

## Scope
1. **Schema (migration `0042_goals.sql`, drizzle journal updated):**
   - `agents.goals`: `id uuid pk, tenant_id, title text, metric_key text, metric_arg text null, target numeric, baseline numeric default 0, due_on date null, status text check in ('active','blocked','done','dropped'), blocked_until timestamptz null, blocker text null, priority int default 100, created_at, updated_at`.
   - `agents.goal_reviews`: `goal_id fk, review_date date, value numeric null, evidence text, pace text check in ('ahead','on_track','behind','unknown'), error text null`, **unique (goal_id, review_date)**.
2. **Metric registry, pure and closed** (`src/goals/metrics.ts`): `metric_key` maps to `(arg, window, deps) => Promise<{ value, evidence } | { error }>`.
   - v1 set: `applications_7d:<profile_id>`, `prs_merged_7d:<owner/repo>`, `issues_closed_7d:<owner/repo>`, `action_count_7d:<action>` and `manual`. The founder reports a `manual` value with `/goal <n> <value>`.
   - An unknown key is rejected when the goal is added, and the reply lists the valid keys as buttons, so the code asks for what's missing instead of guessing.
3. **Pace (pure, `src/goals/pace.ts`).** A rolling-window metric compares the latest value to the target. A cumulative metric compares it with linear pace from `created_at` to `due_on`. With no due date the result is `unknown`, never a made-up pace. Unit-test the boundaries: the due day itself, past due, target 0, and a target already met at creation.
4. **Standup (`src/goals/standup.ts`, zero LLM).**
   - Register `cron.schedule("0 9 * * *", …, { timezone: appTimeZone() })`.
   - For each active goal, claim the `(goal_id, today)` review row with `insert … on conflict do nothing`; losing the insert means another run already did it. Then compute the metric and render one message. Split it at Telegram's 4,096-character limit rather than dropping rows (CLAUDE.md #26).
   - When a goal's metric reaches its target, set `status='done'` and say so once, citing the evidence.
   - Respect `/halt` (`src/infra/halt.ts`).
5. **Commands** (`src/gateway/goal-commands.ts`, registered in `telegram.ts`, owner-only):
   - `/goal add <title> | metric=… target=… by=YYYY-MM-DD`, parsed by a pure parser. A missing or invalid field gets a reply naming the field, with buttons where the options are finite.
   - `/goals` lists goals with today's value.
   - `/goal <n> <value>` records a manual value.
   - `/goal done <n>` and `/goal drop <n>`. Dropped goals keep their history, and nothing is ever deleted.
   - `/goal block <n> <reason> [until=…]`.
6. **"Plan next step" button.** It runs `runKernelText` with a fixed, code-built prompt: goal, metric, the last 7 reviews, and "propose at most 3 actions; any side effect needs its tool's approval". Nothing new is added to the kernel, and the planner, workers and HITL are all the existing ones. When an action is engineering work, the planner's existing `dispatch_antigravity_task` tool files it. After the dispatch branch merges, that path is brief-linted.

## Out of scope
- Automatic goal creation by the planner (v2, after a week of real use).
- Sub-goals or dependencies. Use `priority` to order them.
- Oplify goals: its repos are employer repos, and nothing here files issues into them.

## Edge cases the tests must cover
| Case | Required behaviour |
|---|---|
| The bot restarts at 09:00:30 and the cron fires twice | The unique `(goal_id, review_date)` means one row and **one** message |
| The metric source is down (GitHub 5xx, DB error) | That goal shows "metric unavailable: <reason>", never `0`. Other goals render normally |
| GitHub token 401 | Same as above, with a line naming the fix. The standup still sends |
| Goal `blocked_until` in the future | Shown under "Blocked" with its reason and date. Pace is not computed |
| Target already met when added | Marked `done` at the first standup, with its evidence |
| No active goals | **No message.** Don't send an empty standup |
| 15 goals produce more than 4,096 characters | Split into two messages. Every goal appears |
| `/halt` active | No standup. One line at `/resume`: "standup skipped on <dates>" |
| Timezone day boundary (23:30 UTC is already tomorrow in Amsterdam) | `review_date` is the date in `appTimeZone()`. Test it |
| "Plan next step" tapped twice | The existing kernel lock serializes them. The second tap is refused, not doubled |
| Budget cap reached | The standup still sends, because it's $0. The button reply says the run budget is exhausted |

## Verification
- `pnpm gate`: N/N pass, 0 skipped, counts shown. The migration is applied in the test DB the same way CI applies the others.
- A unit test proves the standup makes 0 model calls: inject a model that throws.
- **Real-path assertion (after merge):**
  1. Add one goal through `scripts/telegram-probe.ts "/goal add …"` from the VPS.
  2. Trigger the standup once by hand with a `pnpm goals:standup --now` script that calls the same function.
  3. The message arrives, and `select * from agents.goal_reviews` shows one row with evidence.
- **Check before merging:** grep `drizzle/meta/_journal.json` for `0042`. Memory records a stale drizzle migration row silently no-op'ing on prod (2026-09-08).
- **NOT VERIFIED from the cloud session:** the prod migration and the live message.

## Founder action after merge
1. Add 2–3 real goals with `/goal add`. Suggested first one, only if you agree: `applications_7d:wife-nl-finance target=5`. It's the number that has been 0 for 30 days.
