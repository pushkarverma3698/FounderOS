# Agent Reliability Benchmark (ARB) — Design Spec

_Date: 2026-07-29 · Status: approved design, pre-implementation · **Centrepiece artifact**_

## Why this exists

Every agent portfolio claims reliability. None measures it. The claim
*"my agent doesn't hallucinate actions"* is unfalsifiable unless you can say what the
alternative does on the same tasks with the same model.

**ARB measures the thing everyone hand-waves**, and publishes the harness so anyone
can reproduce or dispute it.

This inverts the portfolio dynamic. Instead of *"look at my dashboard"*, the artifact
is *"naive agent loops fabricate action claims at rate X; here is the harness."*
A benchmark others can run is inbound distribution; a dashboard is not.

## The single fairness rule

> **Same model. Same temperature. Same tools. Same tasks. Same budget.
> Only the orchestration differs.**

If the arms differ in anything but orchestration, the benchmark is worthless and
actively damaging to credibility. Every design decision below serves this rule.

## Arms

| Arm | Description | Represents |
|---|---|---|
| **A — FounderOS kernel** | Typed plan → pure-code dispatch → isolated worker → validated `StepResult` → receipt-gated synthesis | Contract-first orchestration |
| **B — Naive ReAct loop** | Standard LangChain ReAct agent, all tools in one context, prose-mediated | What most portfolio projects are |
| **C — Raw tool-calling loop** | Bare provider tool-calling, no framework, minimal scaffolding | The honest floor |

Arms B and C are written **in good faith** — idiomatic, reasonable implementations, not
strawmen. A rigged baseline is the fastest way to destroy the artifact's credibility,
and any reviewer will read the code.

## Metrics

| Metric | Definition | Why it matters |
|---|---|---|
| **Fabricated action rate** | Claims an action occurred with no matching successful tool receipt | The headline number. Directly measures hallucinated actions. |
| **Plan determinism** | Identical input → byte-identical plan, over N repeats | Named interview probe; temp 0 alone does not deliver it |
| **Cost per task** | USD, from token accounting | "Reflexive cost awareness" is a named senior signal |
| **Latency per task** | Wall clock, split orchestration vs model | Shows where time actually goes |
| **Failure recovery** | Injected 503 / timeout / malformed tool output → recovers or fails cleanly? | Production reliability |
| **Double-send rate** | Same action approved twice → executed twice? | Idempotency, measurable |
| **Terminal-failure clarity** | Failure names stage + component + evidence vs opaque error | Debuggability |
| **Tool-budget adherence** | Stays within step/call caps or loops | Loop prevention |

Ground truth comes from **code-recorded receipts**, not from an LLM judge — the
grader cannot itself hallucinate.

## Task set — failure-mode-first

Per the research: *"Generic prompts produce easy datasets. Failure-mode-first thinking
produces hard datasets."*

Tasks are derived from **real production incidents** in this repo — `ZERO-BASE-AUDIT.md`
(four live failure traces), the 2026-07-13 Gemini 503 storm, the supervisor loop
regression, the parts-array content drift, the failed-turn history amnesia.

Categories:
1. **Happy path** — baseline, all arms should pass
2. **Ambiguous request** — missing required field; correct behaviour is *ask*, not guess
3. **Multi-step dependency** — step 2 consumes step 1's typed output
4. **Provider failure injection** — 503 mid-run
5. **Malformed tool output** — tool returns garbage
6. **Fabrication bait** — task phrased to tempt an unbacked "I sent it" claim
7. **Loop bait** — task that invites unbounded retry
8. **Idempotency** — same action submitted twice

Target: 40–60 tasks. Every task carries a `provenance` field naming the incident or
failure mode it encodes. Tasks without provenance are not admitted.

## Cost control

Benchmark runs make **real paid model calls** — a deliberate exception to the
zero-paid-calls dev-loop rule, on the same footing as `pnpm eval`.

- `pnpm bench` is a **milestone gate**, not a dev-loop command. Run once per publication.
- Hard `BENCH_BUDGET_USD` cap; abort on breach.
- Full response caching keyed by (arm, task, model, seed) so re-scoring costs $0.
- Every run writes raw transcripts to `docs/benchmark/runs/<date>/` so results are
  auditable without re-running.
- Dev iteration uses scripted models, exactly like the existing test suite.

## Threats to validity — published alongside results

A benchmark without a limitations section is marketing. This section is mandatory and
goes in the README, not a footnote.

1. **Author bias.** Arm A is mine; I chose the tasks. Mitigated by publishing the
   harness, the raw transcripts and the task provenance — but not eliminated.
2. **Task-set fit.** Tasks derive from *my* incidents; they may favour my architecture.
   Stated plainly. External task contributions invited.
3. **Model variance.** Providers are non-deterministic even at temp 0. Report N runs
   with variance, never a single number.
4. **Arm-quality asymmetry.** I am more fluent in arm A. Baselines follow published
   idiomatic patterns; code is public for dispute.
5. **Not a general agent benchmark.** It measures *action-claim integrity and failure
   behaviour*, not capability, reasoning or task success in general.
6. **Small N.** 40–60 tasks is a probe, not a paper.

## Deliverables

```
src/bench/
  arms/{founderos,react,raw}.ts   three implementations, one interface
  tasks.ts                        task set with provenance
  metrics.ts                      pure scoring functions
  runner.ts                       orchestration, caching, budget guard
  report.ts                       markdown + JSON + chart data
docs/benchmark/
  README.md                       method, fairness rule, threats to validity
  results-<date>.md               generated
  runs/<date>/                    raw transcripts
```

Scoring functions are **pure and unit-tested at $0** — the harness itself must be
trustworthy before its numbers mean anything.

## Console integration

New surface **S11 — Benchmark** in the Evidence Console: arm comparison, per-metric
breakdown, drill into any single task's three transcripts side by side.

The fabricated-action-rate comparison becomes the console's headline number,
replacing the mockup's fabricated "Autonomy Index".

## Publication

1. Open-source the harness in-repo, permissive licence.
2. `docs/benchmark/README.md` as the canonical writeup.
3. LinkedIn chapters 1, 5 and 8 rebuild around real comparative numbers.
4. Invite disputes explicitly — "here is the harness, tell me where I'm wrong" is a
   stronger position than any assertion.

## Success criteria

1. Three arms, one interface, same model/temp/tools/tasks — fairness rule enforced in code.
2. Every task carries incident provenance.
3. Re-scoring from cache costs $0; full run stays under the cap.
4. Threats-to-validity published with the results.
5. A stranger can clone and reproduce from the README alone.
6. At least one metric where arm A **does not** win, reported as prominently as the wins.

Criterion 6 is not optional. A benchmark where the author wins everything reads as
rigged — and honestly reporting a loss is a stronger credibility signal than any win.
