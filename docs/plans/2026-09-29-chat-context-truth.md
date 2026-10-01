# Chat answers from current facts, not June's

| | |
|---|---|
| **Branch** | `claude/fix-chat-context-truth` (base `main` @ `1e797039`) |
| **Executor** | Claude cloud session. No VPS or prod DB access, so every prod fact you need is measured below. |
| **Depth** | **Full**: it changes how existing prod data (`agents.founder_context`) is read and rewritten. Run all nine stages of `production-ready`. |
| **One of four** | `claude/fix-dispatch-loop-hardening` · `claude/fix-chat-context-truth` · `claude/feat-goals-daily-standup` · `claude/feat-jobhunt-tashi-and-findings`. Suggested merge order: dispatch, context, goals, jobhunt. |

## The founder moment
He asks "what am I focused on?" or "what is FounderOS?" in Telegram. The reply states the facts it has with **the date each one was last confirmed**. It flags anything older than 30 days as possibly stale instead of stating it as current. He types `/focus <text>` and his focus is updated in 2 seconds, with no model call.

## Measured facts (2026-09-29, prod, `select … from agents.founder_context, jsonb_each(data)`)
- The row is one JSONB blob with 22 keys. **One row-level `last_updated` = `2026-09-28T13:19:27Z`**, but it covers values written in June. `read_context` prints that date under every value (`src/tools/context.ts:48`), which makes June data look one day old. This is the core defect.
- Stale values in prod today:
  - `current_focus` = "Phase D-Bis: 3 proof showcases on proof.turicks.com + LinkedIn build-in-public + Proof Drops…". This is the June plan.
  - `active_projects[0]` = "FounderOS v2 — production LangGraph multi-agent OS (7 departments, … 1250+ tests)". The code today is v3 with 8 workers, and CI ran 5,051 tests on 09-28.
  - `proof_gallery` contains the literal placeholder `http://YOUR_VPS_IP/showcase-1/`.
  - `portfolio_signal` says "FounderOS: production LangGraph multi-agent OS" and is harmless.
- `tech_stack`, `founderos_departments` and `founderos_key_features` are already current, because `SYSTEM_CONTEXT_KEYS` (`src/db/founder-context.ts:58`) rewrites them on every deploy.
- The seed (`scripts/seed-founder-context.ts`) still carries the June defaults for `current_focus` (line 29), `active_projects` (32), `proof_gallery` (71) and `portfolio_signal` (81). Because the seed only fills empty keys, these were written once and never corrected.
- `RETIRED_SEED_VALUES` (`src/db/founder-context.ts:67`) already exists to delete seed values nobody touched. Only `current_priorities` is listed today.
- The planner is told to read context before answering questions about the founder (`src/kernel/planner.ts:80`). So a stale row doesn't get ignored; it gets quoted.

## Binding constraint
The model can't tell a value the founder confirmed yesterday from one the seed wrote in June. Improving the prompt won't fix that. The fix is per-key dates, rendered by code.

**Strongest argument against:** "Just have the founder rewrite the row once." That works for one day. It returns the next time a value ages, because nothing records when it was confirmed. Per-key dates are the mechanism; the one-time rewrite is only its first use.

## Scope
1. **Per-key metadata, no migration.** Add an internal key `context_meta` to the same JSONB, shaped `{ [key]: { at: ISO, source: "founder" | "seed" | "system" } }`. Put it in `INTERNAL_CONTEXT_KEYS` so it never renders as context.
   - `update_context` (`src/tools/context.ts:61`) stamps each key it writes with `source: "founder"`.
   - `reconcileSeededContext` stamps filled keys `source: "seed"` and refreshed `SYSTEM_CONTEXT_KEYS` `source: "system"`.
   - A key with no meta counts as `seed`, dated `1970-01-01`, so it renders "date unknown". Missing data must fail loud.
2. **Pure renderer** `renderFounderContext(ctx, now)` in a new `src/tools/context-render.ts`, unit-tested with no DB. Each line reads `• current focus: … (confirmed 2026-09-30)`. When the key is older than `CONTEXT_STALE_DAYS = 30`, or its source is seed and date unknown, the line reads `• current focus: … ⚠ last confirmed 2026-06-12, may be out of date: ask before relying on it`. Drop the row-level "Last updated" footer.
3. **Retire the June seed values.** Remove the four June defaults from the seed. Add the **exact current seed values** (copy them from the seed file, do not retype them) to `RETIRED_SEED_VALUES`, so a prod value still equal to its seed default gets deleted on deploy. A value the founder edited is never equal, so it survives. Delete the `YOUR_VPS_IP` placeholder the same way.
4. **`/focus` command, zero LLM.** `/focus` with no text shows the current focus and its date. `/focus <text>` sets `current_focus` through the same `sanitizeContextUpdates` guard (`src/tools/context-guard.ts:77`) and stamps meta. `/projects <a>; <b>` sets `active_projects` the same way. Register them next to `/status` in `src/gateway/telegram.ts:151`, add them to `/commands`, and keep them owner-only, as `chat-access.ts` already does for `/task`.
5. **Planner rule, backed by code.** Add one line to the planner prompt: "A context line marked ⚠ must be stated with its date, or asked about. Never present it as current." The ⚠ is produced by code, so the rule has a real input to act on.

## Out of scope
- personal_rag staleness (`docs/plans/2026-09-28-rag-retrieval-cleanup.md` covers it).
- Rewriting history replay (`src/kernel/state.ts`). The 6-hour session gap already bounds it.
- The goals table (the goals branch). That branch reads `current_focus`; this branch only makes it trustworthy.

## Tasks (a failing test first for each)
1. `tests/unit/tools/context-render.test.ts`, RED: fixture = today's prod row (paste the values above). Assert that `current_focus` renders with ⚠ and its date, and that no line says "Last updated: 2026-09-28".
2. `tests/unit/db/founder-context.test.ts` and `tests/unit/scripts/seed-founder-context.test.ts`: extend whichever already covers `reconcileSeededContext`. Assert that a stored value equal to the retired seed value is removed, an edited value survives, and meta is stamped with the right source.
3. `tests/unit/gateway/focus-command.test.ts`: `/focus` sets the value and stamps meta. A guest in an allow-listed group is refused, the same pattern as `/task`. The command makes 0 model calls; inject a model that throws.
4. Implement it. Keep every file under 400 lines, because `verify:arch` enforces a LOC budget.
5. `pnpm gate`, and paste the counts.

## Edge cases
| Case | Required behaviour |
|---|---|
| A key with no meta (every key today) | Renders "date unknown", with ⚠ |
| The founder sets a value identical to the seed default | Meta source is `founder`, so it's never retired |
| `update_context` called with a key the guard rejects | No meta stamped. The rejection message is unchanged |
| Clock skew: meta date is in the future | Treated as today, never negative days |
| Deploy runs the seed twice | Idempotent: second run reports 0 filled, 0 retired |
| `context_meta` itself is corrupt (not an object) | Ignored with one warn log and every key rendered "date unknown". Must not throw |

## Verification
- `pnpm gate`: N/N pass, 0 skipped, counts shown.
- **Real-path assertion (after merge, from the VPS: `cd /opt/review/founderos && node --import tsx/esm --env-file=/opt/founderos/.env scripts/telegram-probe.ts "what is my current focus?" 240`):** the reply contains `⚠` and a June date, or "date unknown", and does not state Phase D-Bis as current. Then `/focus` with a real value, re-ask, and the reply quotes it with today's date.
- **NOT VERIFIED from the cloud session:** anything against prod. Say so in the PR body.

## Founder action after merge
1. Send `/focus <your real focus>` and `/projects <a>; <b>` in Telegram. Nobody else can supply these values.
