# Simplify FounderOS: one loop, one tool layer, one memory

**Date:** 2026-10-08 · **Status:** founder approved in chat 2026-10-08 ("we will go with your decisions")
**Builds on:** the prod chat audit in [2026-10-08-root-fix-task-list.md](2026-10-08-root-fix-task-list.md) and the live run in
[docs/sessions/2026-10-08-heavy-model-live-run.md](../sessions/2026-10-08-heavy-model-live-run.md).
**Supersedes:** the root-fix list (PR #1010), the daily-driver plan (PR #1002), the agent factory plan (PR #923) and AG-038.
Their unfinished briefs are folded in below (§8). This is the only open plan until 11-01.
**Moves:** A.

## 1. The result

You send any plain-English message on Telegram and get the right answer or the right action, the way Claude Code
answers on the laptop. Done means the 5 daily journeys (§5) pass on prod every morning for 7 days in a row, with no fix
merged during that week.

## 2. Where we are (measured 2026-10-08)

| What | Number | Read from |
|---|---|---|
| PRs merged 10-01 to 10-08 | 213: 62 promotions, 59 feat, 58 fix, 18 chore, 14 docs, 2 test | `gh pr list --search merged:>=2026-10-01` |
| TypeScript in `src/` | 95,967 lines in 576 files | `git ls-files src` |
| Largest areas | tools/jobhunt 22,402 · gateway 13,860 · infra 9,336 · db 8,170 · agents 7,067 · kernel 4,260 | `wc -l` |
| Tools the bot carries | about 75, split into 8 departments | `src/agents/capabilities.ts:126-137` |
| Model calls per turn | 3 or more: planner, one worker per step, synthesizer | `src/kernel/graph.ts` |
| Guard modules cleaning up after the model | 8: claim-check, envelope-repair, output-coercion, mission-satisfaction, promise-guard, number-check, progress-guard, tool-output-guard | `src/kernel/` |
| Routing rules in the planner prompt | 18 or more, each added after an incident | `src/kernel/planner.ts` |
| Database tables | 43 (CLAUDE.md says 20). 7 are empty, 1 is a leftover backup | `pg_stat_user_tables` on prod |
| Memory and knowledge stores | 7: brain_memories 2,279 · turicks_brain 1,352 · knowledge_entries 835 · episodic_memory 158 · failure_lessons 24 · personal_rag 4 · founder_context 1 | same |
| Tool layers | 2: the bot's registry, and the VPS MCP hub the laptop uses | `src/agents/`, `src/mcp/` |
| Docs | 359 markdown files: 52 plans, 65 session notes, 9 rule files plus 4 path rules | `git ls-files docs` |
| Scripts / env keys | 166 scripts, 87 keys in `.env.example` | `git ls-files scripts` |
| AG briefs | 48: 31 done, 3 in draft PRs, 14 not started | §8 |
| Golden set | 15 cases: 53% on cheap models, 53% on Sonnet everywhere | session doc |
| Prod chat 10-07 | 2 of 10 founder asks answered right | root-fix list |
| VPS | 4 CPU, 7.6 GB RAM, 43 of 75 GB disk. 5 hub processes left over from laptop sessions, 5 failed `fos-job@` units, 5 containers, 7 cron lines | `ssh founderos-vps` |

## 3. Why it is dumb

1. **Three partial brains.** The planner reads the chat but cannot call tools. The worker calls tools but never sees the
   chat (`src/kernel/worker.ts:4`). The synthesizer writes the reply from validated results only. On the laptop, one
   model sees the chat, every tool and every result.
2. **Tools fenced by department.** GitHub is in engineering, memory and past chats are in admin. A question that needs
   both depends on the planner guessing two departments before it has read anything.
3. **Short memory.** Each past turn is cut to 2,000 characters in and 1,500 out, and history is dropped after 6 hours of
   silence. "That PR" and "the one from this morning" break.
4. **Patching by rules.** Each wrong route got a prompt rule or a guard. The rules interact, and every new phrasing is a
   new edge case. This is why 213 PRs did not converge.
5. **Nothing measures daily use.** Each PR proves its own fix. Nobody runs the founder's real asks every day. The Google
   account mix-up (#1031) was live from the day a second account was added until 10-08.

Two more things make it worse: breadth (jobhunt alone is 23% of `src/`), and outside services that die without warning
(3 of the 4 blockers on 10-08 were credits or quota).

## 4. Target system

```text
Telegram ─► gateway: commands, login pastes and approval taps (no model; never wait behind a running turn)
               │
               ▼
           one agent loop: one model, the last 20 turns in full, an "in flight" block, every tool
               │            a write tool posts an approval card and runs only after the tap (hitlGate, unchanged)
               ▼
           one tool registry: the same list is served to the laptop through the VPS hub (reads only)
               │
               ▼
           one memory table + the chat log + the founder profile
           coding work: one job row, one runner, and the next engine when one is out of quota
```

**Keep**, because each one stopped a real incident: hitlGate inside every write tool, idempotency keys, action_log
receipts, claim-check (the only guard that stays), budget caps, the checkpointer (only for paused approvals), the deploy
path, and the tool implementations themselves.

**Delete once the loop wins (AG-057):** planner, supervisor, synthesizer, worker envelopes, departments, the other 7
guards, and the planner routing rules.

**Move out of the bot process (AG-059):** jobhunt, the evolution self-audit, goals/standup, video tools.

## 5. The 5 daily journeys (the gate)

At 08:00 IST the VPS sends these as the founder over MTProto (the existing `scripts/lib/mtproto.ts`) and scores each
reply in code against the real source. Scoring makes no model call. Detail in [AG-051](../antigravity/AG-051-daily-journeys-and-health-line.md).

| # | Ask, in plain English | Pass when |
|---|---|---|
| J1 | "Anything important in my work inbox since yesterday?" | names at least one real subject from the work account in the last 24 h, or says there is nothing when gws finds nothing |
| J2 | "What's on my calendar today?" | every event gws returns for today is named, or it says the day is empty |
| J3 | "Which FounderOS PRs are open, and is CI green on them?", then "and the oldest one, what's blocking it?" | PR numbers and CI verdicts match GitHub; the follow-up names the oldest PR's number |
| J4 | "Open an issue on FounderOS called `journey <date>` and get an agent on it", tap approve, then "is the agent working on it?" | the issue exists, a job row exists with a named engine, and the status reply matches the job row |
| J5 | "Remind me in 2 minutes to check the journeys", then "what reminders do I have?" | the reminder fires within 4 minutes and the list matches the reminders table |

The existing nightly journeys A, B and C (`scripts/journey-*.ts`) join the same run. One morning message carries the score
and the health line: credits left, Claude CLI limit, each Google login, daemon status, failed job units.

## 6. Rules while this plan runs (until 11-01)

1. **Freeze.** Only the tasks in §7 and fixes for a red journey get merged.
2. **Done means green on prod.** A task is done when the journey it moves passes on prod, not when its PR merges.
3. **Delete before adding.** A PR that adds code says what it deletes, or why nothing can go.
4. **Promote once a day**, after the morning run, unless the fix unblocks a red journey. Last week had 62 promotions.
5. **No new audits.** New findings go into §9 and wait for the plan to finish.

## 7. Tasks

| ID | Task | When | Depends on | Builder | Depth | Moves journey |
|---|---|---|---|---|---|---|
| [AG-050](../antigravity/AG-050-cheap-models-and-output-cap.md) | Cheap default models and an explicit output cap | day 1 | none | Claude | Full (money) | all |
| [AG-051](../antigravity/AG-051-daily-journeys-and-health-line.md) | 5 daily journeys and the morning health line | days 1-2 | none | Claude | Lite | the gate |
| [AG-052](../antigravity/AG-052-vps-cleanup.md) | VPS cleanup: stray hub processes, failed units, unused containers and tables | day 1 | none | Claude | Full (infra) | none: cleanup |
| [AG-053](../antigravity/AG-053-one-tool-registry.md) | One tool registry for the bot and the hub | days 2-3 | AG-042 draft #1007 | Claude | Full | J2, J3 |
| [AG-055](../antigravity/AG-055-in-flight-context-block.md) | "In flight" context block | days 2-3 | none | Antigravity | Lite | J3, J4 |
| [AG-054](../antigravity/AG-054-one-agent-loop.md) | One agent loop beside the kernel, then A/B and switch | days 3-5 | AG-053, AG-055 | Claude | Full | all |
| [AG-056](../antigravity/AG-056-engine-fallthrough-and-honest-job-status.md) | Coding engine fallthrough and honest job status | days 4-5 | none | Claude | Full | J4 |
| **Checkpoint** | A/B table from AG-054. If the loop does not win, stop and rethink before Phase 2 deletes anything. | day 5 | | founder sees the table | | |
| [AG-057](../antigravity/AG-057-delete-the-old-turn-path.md) | Delete the old turn path | days 6-7 | AG-054 switched on for 2 days | Claude | Full | all |
| [AG-058](../antigravity/AG-058-one-memory-table.md) | One memory table; drop empty tables | days 6-8 | AG-054 | Claude | Full (schema) | J3 follow-ups |
| [AG-059](../antigravity/AG-059-side-systems-out-of-the-bot.md) | Jobhunt, evolution, goals and video out of the bot process | days 8-9 | AG-053 | Claude | Full | none: simpler core |
| [AG-060](../antigravity/AG-060-one-coding-pipeline-path.md) | One coding pipeline path (absorbs AG-039, AG-040, AG-041) | days 8-10 | AG-056 | Claude | Full | J4 |
| [AG-061](../antigravity/AG-061-docs-and-rules-prune.md) | Prune docs, rules and env keys; close superseded PRs | days 11-12 | AG-057 | Antigravity | Lite | none: no drift |

Day 1 is 10-09. Phase 0 tasks (AG-050, 051, 052) run in parallel. After day 12, the 7 green mornings run to about
10-27, which leaves room before the freeze ends on 11-01.

## 8. Ledger: every AG brief (48)

**Done (31).**
- **AG-001 to AG-007:** M0A analyzers, fitness rules, precedence. Built in August. The briefs carry no PR tag; the code
  is in `src/evolution/analyzers/` and `scripts/verify-architecture.ts`.
- **AG-008 to AG-011:** #512, #513, #514, #523 and #578.
- **AG-014:** #706.
- **AG-015:** #702.
- **AG-016 and AG-019:** closed, already fixed.
- **AG-017:** #705.
- **AG-020:** #834.
- **AG-021:** #833.
- **AG-022:** #846.
- **AG-024:** #959.
- **AG-025:** #961.
- **AG-026:** #962.
- **AG-027:** #964.
- **AG-029:** #963.
- **AG-030:** #975.
- **AG-034:** #978.
- **AG-035:** #979 and #1013.
- **AG-037:** #977.
- **AG-045:** #1012.
- **AG-046:** #1016.
- **AG-047:** #1014.

**In a draft PR (3).**

| AG | State | Under this plan |
|---|---|---|
| 031 model truth and A/B | part 1 #976 merged; #991 draft | AG-054 uses #991's per-run model override for its A/B |
| 032 working-memory block | #1006 draft | superseded by AG-054 (full turns) and AG-055; close #1006 |
| 042 native tools in the hub | #1007 draft | the starting point for AG-053 |

**Not started (14).**

| AG | Under this plan |
|---|---|
| 012 PR review protocol | dropped: pr-brain does reviews today |
| 013 SuccessFactors adapter | stays on hold (its number did not survive measurement) |
| 018 tailor-CV slop check | after AG-059, inside jobhunt |
| 023 named routines | after the plan: a routine becomes a saved prompt for the loop |
| 028 Telegram and daemons into the brain | folded into AG-058 |
| 033 follow-up referents | superseded by AG-054 (full turns in context) |
| 036 judge scores understanding | folded into AG-051 (journeys are scored by code) |
| 038 single-agent loop | superseded by AG-054. Its gate is met: 53% is below the 85% bar |
| 039 one token, one repo list | folded into AG-060 |
| 040 job file replaces labels | folded into AG-060 |
| 041 promote from Telegram | after AG-060, same path |
| 043 self-host for developers | after the plan: a smaller system is easier to install |
| 048 spec stage follows engine | folded into AG-056 |
| 049 Mac bridge | after the plan |

## 9. Open findings from 10-07 and 10-08

| Finding | Task |
|---|---|
| Sonnet everywhere cost about $0.33 a turn and did not move the golden set | AG-050 |
| A 402 arrives with credit left, because no output cap is sent and the request reserves the model's maximum | AG-050 |
| The free fallback ignores the `list_prs` contract and reads every PR | AG-054 picks the loop model by A/B |
| The Claude weekly limit stops the spec stage; agy is never tried | AG-056 |
| After a failed dispatch the bot said "the spec is being drafted" | AG-056 |
| Replies are long and full of caveats | AG-054 (short system prompt; journeys cap reply length) |
| An issue request is routed to the wrong place | AG-054 (no router) and AG-060 |
| "On it…" stays after Reject | AG-054 (one progress message, closed on every outcome) |
| The cost ledger undercounts against OpenRouter | AG-051 shows the provider's own number; ledger fix in AG-050 |
| A long turn holds the chat lock, so a `/login` paste waits | AG-054 (commands and pastes skip the lock) |
| The bot cannot read the calendar (AG-044 row in #1002) | AG-053 (the hub's `calendar_events` joins the registry) |
| Turicks and Naggar Google accounts are not signed in | founder |

## 10. Exit criteria

1. J1 to J5 plus A to C green on 7 mornings in a row.
2. One tool registry: a CI test checks that the bot and the hub list the same tool names.
3. One memory table; the 7 empty tables dropped.
4. `src/kernel` + `src/agents` + `src/gateway` drop from 25,187 lines to under 12,000, measured at the end.
5. Daily cost shown on the morning line and under `BUDGET_DAILY_USD`.

## 11. The strongest argument against

FounderOS was rebuilt in July (v3) and did not converge either. A second rebuild could lose the guarantees the typed
pipeline was built for: no action claimed without a receipt, nothing sent without approval.

The answer:
- **The guarantees stay.** They live in the tools: hitlGate inside every write tool, receipts recorded by code, and
  claim-check on the final reply. None of them depends on the planner.
- **The loop runs beside the old path.** It takes over only if it wins the measured A/B, and nothing is deleted before then.
- **This rebuild removes parts.** v3 swapped one multi-stage design for another. This one cuts the number of stages from
  three to one.

The main risk is cost. One loop sends more context per call. Prompt caching, the 20-turn window and the tool-result
caps are the controls, and the A/B measures cost next to accuracy.

## 12. NOT VERIFIED

- Whether the loop beats the current path. Nobody has measured it; AG-054's A/B is the test.
- The cost of a loop turn.
- How `brain_memories`, `knowledge_entries`, `episodic_memory` and `failure_lessons` divide their roles. Only one split is
  known to be on purpose: `src/db/schema.ts:417-418` keeps `personal_rag` apart from `turicks_brain` (ADR-013/015), so
  AG-058 leaves those two alone and maps the other four before merging anything.
- The status of AG-001 to AG-006, which is inferred from code and the README, not from PRs.
- Who owns the `jolly-babbage-job-tracker` container on the VPS. AG-052 asks the founder before touching it.
