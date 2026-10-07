# Plan: FounderOS understands what the founder means (60 → 85)

**Source:** [2026-10-07-queue-context-tools-audit.md](2026-10-07-queue-context-tools-audit.md) §3–§4. 189 founder turns
graded by hand: 72% OK overall, 67% OK on follow-ups, 82% OK on standalone asks.
**Goal:** at least 85% of the golden understanding cases pass on the live model, and follow-ups score no worse than
standalone asks.
**Freeze:** every task except AG-037 changes frozen paths. Each PR needs the `unfreeze` label, which only the founder
approves. AG-037 qualifies as `crash-fix`.

## Binding constraints (measured 2026-10-07)
- `src/kernel/planner.ts` is **399 lines**, and the cap is 400 (`verify:arch` rule 4). A new planner block must live in its
  own module and add at most one line to `planner.ts`. AG-029 (PR #963) already adds a block there.
- Prod `.env`: `AGENT_MODEL=google-genai:gemini-3.6-flash` and
  `WORKER_AGENT_MODEL=openrouter:inclusionai/ling-3.0-flash`. Yet every one of the 311 `ai_call_costs` rows of the last
  7 days, worker and synthesizer included, says `google-genai:gemini-3.6-flash`.
- `MAX_TOOL_CALLS_PER_STEP = 6` (`contracts.ts:176`). History keeps 20 turns / 16,000 chars and is dropped after
  6 h of silence (`state.ts:149,151,175`).
- The live judge (`src/infra/judge.ts`) scores groundedness, relevance and completeness against this turn's step
  results only. It never sees the previous turns, so it cannot detect a misunderstood follow-up.
- The service stopped 86 times in 7 days (10-01 → 10-07), every one a clean `systemctl restart`. The Deploy workflow ran
  81 times in the same window. `shutdown()` does not wait for turns in flight (`src/index.ts`).

## Already in flight (do not duplicate)
| Work | Where | Relation |
|---|---|---|
| Recent cross-agent activity block in the planner + nightly retrieval eval | AG-029, PR #963 | AG-032 extends this block; it does not add a second one |
| `/goal` fails to save (`agents.goals` has 0 rows) | issue #966, PR #967 | AG-032 reads goals once #967 is live |
| Gmail/Calendar `invalid_grant` since August | founder only | Re-auth through `/login` |
| "I'll monitor" promise guard | `src/kernel/promise-guard.ts`, on beta | AG-034 adds progress and number checks beside it |

## Tasks
| # | Brief | What it fixes (turn ids) | Depth | Depends on | Size |
|---|---|---|---|---|---|
| 1 | [AG-030](../antigravity/AG-030-understanding-golden-set.md) multi-turn golden set | measures everything below | Lite | none | 0.5–1 d |
| 2 | [AG-031](../antigravity/AG-031-model-truth-and-strong-model-ab.md) model routing truth + strong-model A/B | flash at every stage (#396, #297, #522) | Full | AG-030 for the A/B half | 1 d + 1 paid eval |
| 3 | [AG-032](../antigravity/AG-032-founder-working-memory-block.md) working-memory block | doesn't know founder, family or self (#304, #312–314, #363) | Full | AG-029, #967 | 1.5 d |
| 4 | [AG-033](../antigravity/AG-033-follow-up-referents.md) follow-up referents | wrong PR, wrong repo, old task replayed (#361, #382, #411, #525, #561) | Full | AG-030 | 1.5 d |
| 5 | [AG-034](../antigravity/AG-034-no-unbacked-promises-or-numbers.md) no unchecked progress or invented numbers | "actively executing", invented stats (#396, #297, #522) | Lite | none | 1 d |
| 6 | [AG-035](../antigravity/AG-035-investigation-depth.md) investigation depth | gives up at 6 calls, can't read its own code (#300, #321, #561) | Full | none | 1 d |
| 7 | [AG-036](../antigravity/AG-036-judge-scores-understanding.md) judge scores understanding | judge 95/98 while it misreads | Lite | AG-030 | 0.5 d |
| 8 | [AG-037](../antigravity/AG-037-restart-root-cause.md) deploys drain turns | silent dropped turns (#360, #378) | Full | none | 1 d |
| 9 | [AG-038](../antigravity/AG-038-single-agent-conversation-loop.md) single-agent loop for read/think turns | whatever 1–8 leave red | Full | 1–4 merged and measured | 3–5 d, **only if needed** |

## Order
1. **AG-030 first.** It turns the failing prod turns into tests. Every later PR quotes its score before and after.
2. **AG-031 in parallel.** The routing-truth half needs no golden set; the A/B half needs AG-030.
3. **AG-032 and AG-033** once AG-029 is merged. They touch different files: the working-memory block vs envelope and
   history.
4. **AG-034, AG-035, AG-037** can run any time in parallel; none touches the planner prompt.
5. **AG-036** after AG-030. It reuses the golden cases to calibrate the judge.
6. **Gate for AG-038:** after 1–4 are on prod, run the golden set. At ≥ 85% the plan is done and AG-038 is not built.
   Below 85%, the founder decides whether to build AG-038.

## How we will know it worked
- Golden set (AG-030) on the live model: baseline today vs after each PR, in each PR body.
- A one-week re-grade of real founder turns with the audit's labels, compared with the 72% / 67% / 82% baseline. The new
  judge score (AG-036) makes this automatic.
- Zero unchecked progress claims (AG-034 `claim.check` trace counter); the number-check log gives a week of data.

## Strongest argument against this plan
A stronger model alone (AG-031) might fix most of it, making AG-032/033 premature. That is why AG-031's A/B runs before
AG-032/033 are built: if Sonnet or Gemini Pro on today's graph already passes ≥ 85%, AG-032/033 shrink to the cases it
still fails.

## Founder decisions needed
1. `unfreeze` for this plan (all tasks but AG-037).
2. Model spend: AG-031's A/B costs one paid eval run per model (each about $1–3 on the golden set; NOT VERIFIED until
   AG-030 fixes the case count). Switching prod to a stronger model raises per-turn cost; AG-031 reports the number.
3. Gmail/Calendar re-auth (`/login`).
