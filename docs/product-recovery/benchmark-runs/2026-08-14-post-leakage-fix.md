# Reality Benchmark — post-leakage-fix run, 2026-08-14

**Prod commit under test:** `f88c6a8` (deployed 08:16:36 UTC)
**Window:** 2026-08-14T08:17:05Z → 08:35:26Z
**Corroboration:** 24/24 turnIds matched against prod's own journald export
**Raw evidence:** `2026-08-14-post-leakage-fix.md.raw.json`, `.evidence.jsonl`

## ⚠️ This run is NOT SCORED, deliberately

`pnpm verify:benchmark` is not run against this file and no per-task dimension
scores are published, because **the capture cannot be trusted at task
granularity.** Publishing scores from it would be publishing a false baseline —
the exact failure caught twice before (see [the 05:xx baseline](2026-08-14-baseline.md)).

Root cause, proven rather than assumed: **six of the 24 turns never produced a
`turn.out` seam** — `A1, A3, A6, D3, D4, E4`. They ended at an HITL approval
card. Traced end-to-end for A1 (`turnId 5586536f-f5f0-4c7a-b193-ebc38140253b`):

```
08:17:05.641  turn.in       "what all jobs has been captured give me a csv"
08:17:07.723  turn.progress "🔧 jobhunt: Retrieve the full set of captured jobs using job_state and …"
08:17:08.763  tool.call     job_state
08:17:09.000  tool.result   303 postings
              (no turn.out — suspended on an approval card)
```

`reattribute` partitions Telegram messages to the nearest `turn.out`. A turn with
no `turn.out` has nothing to attract its own messages, so its approval card lands
on a neighbour. Observed directly: **A2's reply carries A1's
`job_applications_export.csv` card**, and **A7's carries A6's
`job_search_pipeline_costs_aug7_aug14.csv` card**. Per-task attribution is
therefore wrong for at least four tasks, and cannot be assumed correct for the rest.

The fix is a harness change — partition on `turn.out` **or** `hitl.interrupt`,
whichever terminates the turn. Tracked separately; not applied here, because
changing the harness mid-analysis is how a benchmark starts measuring itself.

## What this run DOES establish

Leakage is a property of the **corpus of replies**, not of which task a reply
belongs to. It survives the attribution defect intact, and it is the thing the
run was commissioned to measure.

| Measure | Baseline (05:xx, `8a5b9a3`) | This run (`f88c6a8`) |
|---|---|---|
| Replies leaking a **tool name** | **22 / 24** | **1 / 24** (C5, `deliver_artifact`) |
| Replies leaking an **absolute path** | every artifact card | **1 / 24** (A2, `/api/v1/health`) |
| Replies carrying the founder receipts line | 0 | 16 / 24 |

The single path leak is `/api/v1/health` inside the static `/start` capability
guide — a command handler's fixed help text, which never passes through the
synthesizer and is not model-generated.

## Fixes confirmed live

**A5 — cost retrieval.** The identical prompt that yesterday returned *"could not
be retrieved because specific token counts and dollar amounts were not logged"*
now returns:

> Total Spend: $0.282963 USD across 631 AI calls (3,041,801 tokens in, 145,642 tokens out)
> • google-genai:gemini-flash-latest: 550 calls | $0.245619
> • openrouter:cohere/north-mini-code:free: 37 calls | $0.020970
> • openrouter:google/gemini-2.0-flash-001: 44 calls | $0.016374

The data was always there — `ai_call_costs` holds 1,627 rows / $2.4415 spanning
2026-07-04 → 08-14. The `costs` scope was reading `job_ingest_runs`, which has no
dollar column, so the agent was reporting the table it was handed. Not a
hallucination; a wiring defect.

**Artifact approval card.** Was `Deliver artifact at /home/founderos/Projects/founderos/artifacts/x.csv`.
Now:

> 📄 Send you this file?
> Send "job_applications_export.csv" to this chat

**Founder receipts line.** Was a per-tool inventory with args hashes. Now
`✓ 3 actions completed and verified`. The internal receipts are unchanged and
still carry tool, timestamp, args hash and result digest.

## Defect this run found that the fix had missed

The progress line shown *while* a turn runs was still built from `step.worker` and
`step.objective` — see the A1 trace above. Fixed in #495 / #496, deployed after
this run. **Not covered by the numbers above**, which were measured before it landed.

## Honest status of the other dimensions

Intent, source, completeness, artifact, delivery, truthfulness and friction are
**not scored** for the reason at the top. Reading the replies suggests
truthfulness held — B2 states a root cause and names an unfulfilled delivery, A7
volunteers *"only 20 of the 35 rejected roles are visible"* rather than implying
completeness — but "suggests" is not a score, and this file will not pretend
otherwise. A scored run needs the harness fix first.
