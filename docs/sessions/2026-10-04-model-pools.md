# 2026-10-04 — model pools, measured

Outcome: per-role fallback pools (`PLANNER_FALLBACK_MODELS`, `WORKER_FALLBACK_MODELS`) and a measured pick
for each role. Moves: D.

## How it was measured
`COMMAND_GOLDEN_TASKS` (36 plain-words→command tasks) + `GOLDEN_TASKS` routing (41) through the real planner
node, plus 27 worker first-turn tool calls with the real worker prompts and tool schemas. Temp 0, OpenRouter,
one run per model, two for the finalists. Total spend about $3.5 of a $5 key. A run is small, so a 1-2 task
gap is noise; read the columns, not the rank.

| model | cmd /36 | route /41 | planner p50 | worker valid args /27 | worker p50 | cost per run (planner+worker) |
|---|---|---|---|---|---|---|
| google/gemini-3.6-flash (today) | 36 | 37 | 4.5s | 27 | 2.6s | $0.44 |
| deepseek/deepseek-v4.1-flash | 35 | 35 | 3.0s | 27 | 1.7s | $0.14 |
| nvidia/nemotron-3-super-120b-a12b:free | 34 | 32-35 | 2.2s | 27 | 1.3s | $0 (rate-limited) |
| xiaomi/mimo-v2.6-flash | 34 | 35 | 5.1s | 22 | 2.5s | $0.05 |
| z-ai/glm-5.3-flash | 36 | 34 | 4.6s | 26 | 2.7s | $0.08 |
| typesafe/jev-router | 35 | 34 | 2.9s | 26 | 2.6s | about $0.05 measured from key usage (list price is -1) |
| inclusionai/ling-3.0-flash | 31-32 | 32 | 1.6s | 26-27 | 1.2-1.4s | $0.01 |
| deepseek/deepseek-v4-flash | 33-34 | 27-28 | 2.0s | 27 | 1.4-1.8s | $0.01 |
| qwen/qwen3.8-flash, qwen3.7-flash | 33-34 | 33-34 | 5.5s | 15-21 | 1.1-3.9s | $0.02-0.07 |

## Findings
1. Plain-words→command is easy: nearly every model gets 33+/36. Routing a real task to the right worker
   needs reasoning; reasoning-off planners are 5-8x faster but route worse (`route` 27-33 vs 35).
2. Worker first turns are where cheap models win: ling-3.0-flash does it in 1.2s at $0.003 per 27 calls,
   30x cheaper than gemini-3.6-flash. Turning reasoning off gave no speed gain there and cost valid args
   (deepseek-v4.1-flash 27→24), so no reasoning switch ships.
3. Qwen flash models emit invalid tool args (15-21 valid of 27): not for workers. qwen3.5-flash burns its
   token budget on reasoning (74/74 failures). kimi-k3 costs too much, minimax-m3 has tail latency, and
   glm-5.3-flash / step-3.7-flash 400 if reasoning is disabled.
4. Free models: only nemotron-3-super (and ultra, slower) are usable; everything else 429s or fails.
   The free tier shares one per-minute limit, so free models are fallbacks, never primaries.
5. Jev earned a challenger slot (stable, fast, cheap) but not first: its price is variable and its routing
   is 1-3 tasks below gemini. It goes last in the planner pool until real traffic says otherwise.

## Recommended pools (founder applies on the VPS)
- Worker + synthesizer primary: `WORKER_AGENT_MODEL=openrouter:inclusionai/ling-3.0-flash`
- `WORKER_FALLBACK_MODELS=openrouter:deepseek/deepseek-v4-flash,openrouter:nvidia/nemotron-3-super-120b-a12b:free,openrouter:google/gemini-3.6-flash`
- Planner primary: keep `AGENT_MODEL` (gemini-3.6-flash) for about a week; it is the only model at 36/36 and 37/41.
  Switch to `openrouter:deepseek/deepseek-v4.1-flash` if the first week of traffic shows no routing regressions
  (it is 3x cheaper and faster, 2 routing tasks lower in one run).
- `PLANNER_FALLBACK_MODELS=openrouter:deepseek/deepseek-v4.1-flash,openrouter:nvidia/nemotron-3-super-120b-a12b:free,openrouter:xiaomi/mimo-v2.6-flash,openrouter:typesafe/jev-router`

## NOT VERIFIED
- Quality on real traffic: the bench is the golden set, not the founder's messages.
- The combined planner+worker pools through a live Telegram turn.
- One run per model for most rows; free-model numbers move with load.
