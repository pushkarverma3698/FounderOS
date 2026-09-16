# 2026-09-16 — The fallback chain was unreachable: why every turn took five minutes

## What we did

Ran the live MTProto founder-simulation against prod after shipping `read_logs`
([#680](https://github.com/pushkarverma3698/FounderOS/pull/680)), using the exact prompt that
fabricated an audit on 2026-09-15: *"Read founderOs logs and reason as many bugs as you can"*.

`read_logs` worked — the planner called it with real parameters and got real journal lines. But
the turn still died at `300012ms` and the founder received nothing. The instrument was fixed and
the founder's experience was unchanged, which is the failure [rule #26] exists to catch.

So we read the journal for the failing turn instead of theorising about it.

## What we fixed

**The fallback chain could never run.** `withModelFallbacks` raced the **primary** against the
**whole** resolution budget:

```ts
return await raceWithDeadline(primary.invoke(messages), budgetMs, label);
```

A primary that failed by exhausting that budget therefore left `remaining() === 0`, and the very
next loop threw at `fallbackIndex: 0`. Prod, 2026-09-16:

```
16:48:46 model-retry    attempt 1  "Model call exceeded 45000ms (worker)"
16:49:29 model-retry    attempt 2  503 Service Unavailable (gemini-flash-latest)
16:50:01 model-fallback "Primary model failed retriably — engaging fallback chain"
16:50:01 model-fallback "Resolution budget exhausted — skipping remaining fallbacks"
                        fallbackIndex: 0, budgetMs: 120000
16:52:19 trace          turn.error "Office turn exceeded 300000ms"
```

The chain could only ever engage when the primary failed **fast** — precisely the case that does
not need a fallback. During a real outage, every configured fallback was unreachable, and the 300s
turn watchdog was reached on model backoff alone.

The primary now gets `budgetMs - chainReserveMs`, the reserve being one fallback attempt, capped
at half the budget so a small budget cannot starve the primary instead.

Second, smaller fix: `read_logs` gained the per-thread repeat guard `github_read` already had. The
failing turn spent four `read_logs` calls, two of them after the window was already in context.

Third: `scripts/telegram-probe.ts` — a one-prompt MTProto probe. The repo had only the 22- and
34-task batteries, both milestone gates costing minutes and real tokens, so the standing directive
("drive it through Telegram before calling it done") kept being approximated by SSH tool calls that
prove the tool and nothing about the planner or the reply.

## Why

Three layers each had a sane-looking bound — 45s per attempt, 90s of retry, 120s of resolution —
and 300s above them all. No single constant was wrong. The defect was the **relationship**: the
layer that owned the budget spent all of it before the layer that needed it was consulted. No unit
test saw this, because each layer's tests bound only that layer.

It survived because the fallback path is only exercised during a provider outage, and the mocked
tests that covered it used values where the inner layer surrendered early. The prod numbers do not
have that property.

## Metrics

Same prompt, same 503-storm conditions, before and after:

| | Before (16:47) | After (17:28) |
|---|---|---|
| `read_logs` calls | 4 | 2 |
| Fallback engaged | never (`skipping remaining fallbacks`) | **`Fallback model answered`** |
| Primary race window | 120000ms (whole budget) | **75000ms** (budget − reserve) |
| Turn outcome | `turn.error` @ **300012ms** | **`turn.out` @ 200241ms** |
| Founder received | nothing | a log-grounded answer |

`pnpm gate`: 397 files / 4,433 tests green. New regression test written RED-first, confirmed
failing with `ModelCallTimeoutError: Model call exceeded 100ms` before the fix.

Prod verified by `ActiveEnterTimestamp`, not `git rev-parse` — the documented false green.

## Outstanding

1. **`brain:sync` writes to the wrong database and reports success.** The laptop `.env` has
   `DATABASE_URL=postgres://…@localhost:5432/founderos`, so a sync run from this machine reports
   `✅ Sync complete` while the VPS brain the agents actually read receives nothing. `read_logs`
   appears in **zero rows** across `brain.knowledge_entries`, `brain.brain_memories` and
   `brain.turicks_brain`; the newest write in the prod brain predates this session's work.
2. **85 stale senior roles sit in the apply queue.** The level gate ships and works — a post-deploy
   "Senior Solutions Architect" was correctly rejected — but rows screened before it merged were
   never re-screened. `scripts/jobhunt-rescreen.ts` is read-only and cannot fix this; a backfill is
   needed.
3. **Neither profile sets `maxTitlePass`/`maxTitleStretch`**, so both inherit the SENIOR default.
   `level.ts`'s own header states Tashi at 2.4 years should have senior FLAG to stretch; that intent
   is documented but not configured.
4. **The judge model is dead again** — `openrouter:nvidia/nemotron…` threw
   `Cannot read properties of undefined (reading 'message')` on this very turn. Non-blocking.
