# 2026-10-08 — heavy model on prod, live Telegram run

## What we did
- Moved planner, workers and synthesizer to Claude Sonnet 5.5 via OpenRouter (#1015). The Google AI Studio key returns 402 (prepaid credits used up), so the old Gemini stack failed every call.
- Raised the tool budget by step class: 10 calls for write steps, 20 for read steps, recursion limit 150 (#1013).
- Drove prod through the real MTProto path as the founder (`scripts/telegram-probe.ts` from `/opt/review/founderos-eval`), before and after each fix.

## What we fixed
| PR | Defect seen live | Fix |
|---|---|---|
| #1014 | A message sent while an approval card was open got lost | It is held, then runs once the card is answered (29s end to end, live) |
| #1020 | "Is CI green on the open PRs?" spent the whole 20-call budget on get_pr per PR; "what merged today?" had no merged listing | `list_prs` gives a CI verdict per open PR and has `state=merged` |
| #1022 | Progress line read "Step 1 of 1: Use to open a GitHub issue" | Tool names become "a tool" instead of a hole |
| #1025 | "What merged to beta today?" fell back to a gated shell `git log` and blocked on a card; CI ask still called get_pr on all 10 PRs | Contract says `list_commits` takes `ref`; `get_pr` returns the same `ci` verdict as `list_prs` |
| #1027 | "Is CI green?" ended in a failure card: "402 This request would exceed your available credits" | A credits-empty 402 walks the fallback chain to the free nemotron model; 401 still fails loud |

## Why
The model was not the main failure. Golden set: 53% on the old base model and 53% on Sonnet. Most wrong or missing answers came from tool gaps: a read the model needed did not exist, or the contract did not say a parameter existed. The model then improvised (raw check runs, shell commands) and padded the reply with "not verified" caveats.

## Metrics
| Ask | Before (Gemini, pre-fix) | After Sonnet + #1013 | After #1020/#1022 | After #1025 |
|---|---|---|---|---|
| What was merged to beta today? | 16s, wrong ("none merged") | 70s, correct | `list_prs merged` called right; blocked on a shell card (fixed by #1025) | 64s, correct, 15 PRs, no card |
| Plan doc, 5 points | 3s, answered the previous question | 43s, correct | — | — |
| What shipped to prod today? | 7s, never answered | 82s, correct | correct after the card was cleared (held-message path) | — |
| Open PRs, is CI green? | — | 123s, budget hit, 3 PRs unverified | 94s, all 10 PRs, 12 tool calls | 402 credit failure at 29s (fixed by #1027) |

- Cost: about $0.30–0.35 per Sonnet turn. `BUDGET_DAILY_USD=5` covers roughly 15 turns a day. Today's spend reached $3.08 during testing.
- Latency is now 40–120s per read question, against 3–16s before. The early answers were fast because they were wrong.

## Outstanding
- OpenRouter credits are nearly spent (key limit $10, under $1 left). This is the binding constraint for daily use.
- Replies are still long and caveat-heavy.
- "Create a GitHub issue" is planned as an Antigravity dispatch card. This is routing, AG-038 territory.
- After a Reject tap, a stale "On it…" progress line is sent just before "👍 Dropped".
- The daily budget versus Sonnet cost needs a founder decision.
- `search_web` grounding stays dead until AI Studio is topped up.
