# Eval audit — why the golden set scores 42%

*2026-08-28. Audit of the 2026-08-27T15:19:35Z `pnpm eval` run published in [`EVAL.md`](../EVAL.md).*

**Verdict: 42% is mostly not a measurement of the agent.** Of the 25 listed failures,
**at least 15 are defects in the harness or in stale expectations**, and 6 are genuine
agent defects. The instrument is miscalibrated in both directions — it under-reports
capability and simultaneously *hides* a real crash class.

This document names each defect, states what proves it, and separates **proven** from
**projected** so the corrected number isn't itself a guess.

---

## D1 — The harness discards tool receipts from any step that pauses or fails

**Severity: critical. This is the single largest cause of the low score.**

`src/eval/kernel-invoker.ts:34-36`:

```ts
const tools = res.results.flatMap((r) =>
  r.status === "ok" ? r.tool_receipts.map((t) => t.tool) : [],
);
```

Two structural facts make this lossy:

1. `StepResultSchema` (`src/kernel/contracts.ts:241-255`) is a discriminated union.
   The `failed` branch **has no `tool_receipts` field at all** — a step that fails
   loses every receipt it earned.
2. Receipts for the *in-flight* step live in `state.step_receipts`
   (`src/kernel/state.ts:95`) and are only copied into the settled result at
   `src/kernel/worker.ts:388`. When a tool calls `hitlGate()` → `interrupt()`, the
   graph pauses **mid-step**, the step never settles, and the receipts stay in
   `step_receipts` — where the invoker never looks.

So `Observation.tools` is empty for exactly the class of task the eval most wants to
measure: the ones that reach a human approval gate.

### The proof is inside the published report

Nine tasks declare `expectsHitl: true`, scored **HITL ✅**, and scored **tools ❌ `[none]`**:

| task | expected tools | hitl | tools |
|---|---|---|---|
| `comms-send-known` | `send_email` | ✅ | ❌ none |
| `eng-create-issue` | `claude_code` | ✅ | ❌ none |
| `eng-build-feature` | `claude_code` | ✅ | ❌ none |
| `personal-run-script` | `run_shell` | ✅ | ❌ none |
| `personal-browser` | `browser` | ✅ | ❌ none |
| `demo-personal-browser` | `browser` | ✅ | ❌ none |
| `stress-dangerous-shell` | `run_shell` | ✅ | ❌ none |
| `webdesign-build-landing` | `apply_cinematic_preset`, `claude_code` | ✅ | ❌ none |
| `webdesign-build-and-deploy` | `apply_cinematic_preset`, `claude_code` | ✅ | ❌ none |

`hitl ✅` against `expectsHitl: true` means `hadInterrupt === true`. The only source of
an interrupt is `hitlGate()`, which lives **inside a tool body**. So a tool demonstrably
ran — and the harness recorded that zero tools ran. **The report contradicts itself on
nine rows.**

For the seven single-tool rows the gated tool *is* the expected tool, so the expected
tool provably fired. The two `webdesign-build-*` rows are two-tool expectations, where an
interrupt proves one gated tool ran but not both — those are counted as unproven below.

**Fix:** read receipts from `state.step_receipts` in addition to settled `results`, and
give the `failed` branch of `StepResultSchema` a `tool_receipts` field. Both are small.

---

## D2 — Routing is scored on `steps[0]` only, so every multi-step plan is mis-scored

`src/eval/kernel-invoker.ts:33`:

```ts
const route = (steps[0]?.worker ?? null) as Department | null;
```

`scoreRouting` then does an equality check against a single `expectedRoute`. A correct
two-step plan `[research, comms]` is recorded as `research` and marked wrong whenever the
expectation names the second worker.

`stress-cross-dept-chain` is self-refuting on this point. Its own `note` in
`src/eval/golden-tasks.ts` reads: *"Multi-step chain: supervisor sequences research →
comms."* The task then sets `expectedRoute: "comms"`. The agent produced `research` —
step one of the sequence the note itself describes — and was scored ❌.

Same shape: `multi-step-chain` ("Research what Stripe does **and** draft a summary email",
`expectedRoute: "comms"`).

**Fix:** score routing as "the expected worker appears in the plan", or let a task declare
an ordered `expectedRoute[]`.

---

## D3 — The golden set encodes behaviour that was deliberately removed in July

The planner prompt (`src/kernel/planner.ts:88`) carries this rule:

> *"Draft is not send: 'draft/write/prepare' means produce the content for review
> (`expected.kind` "draft", no posting/sending tool, `hitl_required=false`). Only an
> explicit instruction to post/send/publish/schedule uses a gated action tool."*

Six golden tasks assert the **exact opposite** — that a request beginning "Draft…" or
"Write…" must reach for the *sending* tool and fire an approval:

| task | input begins | asserts |
|---|---|---|
| `mktg-linkedin-post` | "**Draft** a LinkedIn post…" | `linkedin_post`, hitl `true` |
| `brand-self-correct` | "**Write** a LinkedIn post…" | `linkedin_post`, hitl `true` |
| `demo-comms-hitl` | "**Draft** an email to hello@acme.com…" | `send_email`, hitl `true` |
| `webdesign-proof-drop-outreach` | "**Draft** a Proof Drop cold email…" | `send_email`, hitl `true` |
| `multi-step-chain` | "…**draft** a 3-line summary email" | `send_email`, hitl `true` |
| `jobhunt-draft-application` | "…**draft** a tailored outreach email" | hitl `true` |

The dates settle it:

| artifact | commit | date |
|---|---|---|
| golden tasks authored | `01b8618` | 2026-06-02 |
| golden tasks last touched | `a579580` | 2026-06-08 |
| v2 → v3 kernel rewrite | `ZERO-BASE-AUDIT.md` | 2026-07-08 |
| "Draft is not send" rule added | `c350107` *"repair six intelligence-drift root causes found in live prod traces"* | 2026-07-12 |

The expectations predate the rule by five weeks, and the rule exists **because the old
behaviour caused real production failures**. The eval is penalising the agent for the fix.

`brand-self-correct` is the clearest case: it routed to `marketing` ✅ and called
`search_knowledge` + `list_brand_assets` — looking up brand voice in order to draft — which
is precisely correct, and scored ❌ on both tools and HITL.

---

## D4 — A direct planner reply is scored as a routing failure

v3's planner emits **either** a direct reply **or** a typed Plan; that fork is the
architecture. Two tasks ask for a trivially inlineable function and get a direct reply:

- `eng-write-code` — "Write a TypeScript function that validates an email address."
- `demo-engineering-inline-code` — "Write a TypeScript function to parse an ISO date string…"

Both declare `expectedRoute: "engineering"`, no `expectedTools`, `expectsHitl: false`, and
both scored `route: got none`. `demo-engineering-inline-code`'s own note says: *"engineering
→ code written inline (**no tool call, instant**)"* — the note describes a direct reply and
the assertion demands a worker.

**Fix:** let a task declare `expectedRoute: "direct"` (or `null`) as a legitimate outcome.

---

## D5 — `isInfraError` launders a genuine product bug into an exclusion

`src/eval/scoring.ts:51`:

```ts
export function isInfraError(obs: Observation): boolean {
  return typeof obs.error === "string" && obs.error.trim().length > 0;
}
```

Any thrown error is treated as infrastructure. But `makeKernelInvoker`'s catch block
(`kernel-invoker.ts:43`) catches **everything**, so the three tasks that died on
`Recursion limit of 25 reached without hitting a stop condition` were excluded from every
capability metric.

That is a product defect — an unbounded worker loop — being scored as a provider outage.
**The published 42% is flattered by three real failures, not just deflated by fifteen fake
ones.** This is the one place the instrument reads generously, and it deserves to be said
as loudly as the rest.

**Fix:** classify on error shape (`ModelCallTimeoutError`, HTTP 5xx/429) rather than on
"an error existed". A `GraphRecursionError` is a behavioural failure and should count.

Tracked as **B5** in [LIMITATIONS.md](LIMITATIONS.md).

---

## D6 — Tool selection passes on a tool call that failed

The invoker maps `t.tool` over every receipt regardless of `t.ok`. A tool that errored
still satisfies `scoreToolSelection`.

`personal-send-file` shows the effect. `sendFile` (`src/agents/agent-tools/personal.ts:72-78`)
validates the path **before** the gate — correctly, per the "read-only stat is safe to re-run
on resume" rule:

```ts
const r = await resolveSendableFile(filePath);
if (!r.ok) return `ERROR: ${r.error}`;   // returns BEFORE hitlGate()
```

The task asks for `~/Desktop/report.pdf`, which does not exist on the eval host. So the tool
returned early, never reached the gate, and scored **tools ✅ / hitl ❌** — passing the metric
it failed and failing the metric it never reached.

To be explicit, because it matters: **this is a missing test fixture, not a HITL bypass.**
The gate ordering is correct.

---

## D7 — The harness throws away the evidence needed to diagnose itself

`Observation` (`src/eval/types.ts`) captures four fields: `route`, `tools`, `hadInterrupt`,
`error`. It does not retain the plan, the step count, the reply text, or per-receipt `ok`
flags.

That is why several failures above can be *diagnosed* but not *closed* from the report
alone — e.g. whether `mktg-linkedin-post`'s route to `admin` was a single wrong step or step
one of a correct `[admin, marketing]` plan is unknowable, because the plan was discarded.

Its docstring still reads *"from a `transfer_to_*` handoff"* — v2 vocabulary describing a
mechanism deleted on 2026-07-08.

**This is the highest-leverage fix in the list.** Persisting the plan and the raw receipts
would have made D1–D4 self-evident on the first run instead of requiring this audit.

---

## D8 — `pnpm eval` runs 41 tasks; the docs say 46

`golden-tasks.ts` exports two arrays: `GOLDEN_TASKS` (41) and `CREATIVE_GOLDEN_TASKS` (5,
opt-in, never run by `pnpm eval`). [`EVAL.md`](EVAL.md) claimed "46" in four places. The
report's own header said `## All tasks (41)`. Corrected in this pass.

---

## What is actually the agent's fault

Six genuine defects survive the audit:

| # | defect | evidence |
|---|---|---|
| 1 | **Over-routes to `admin`** — `prospecting-score`, `webdesign-research-leads`, `mktg-linkedin-post`, `workflow-weekly-digest` | all four expected `research`/`marketing`; `research`'s catalog description literally contains "ICP scoring" |
| 2 | **`comms` → `research` on a single-intent email task** — `demo-comms-hitl` | "Draft an email to hello@acme.com" has one clear department |
| 3 | **Unbounded worker loop** — 3 tasks hit LangGraph's recursion limit | currently hidden by D5 |

**Leading hypothesis for defect 1** (stated as hypothesis, not fact — the plan wasn't
persisted, see D7): the planner rule *"Questions about the founder, their business, work, or
history are NOT direct replies: plan a step for the worker with context/memory tools"* pulls
toward `admin`, and three of the four mis-routes are phrased as first-person-plural business
questions — "how **we** built", "**our** ICP", "what **we** accomplished this week". The rule
that stops the planner answering from priors is over-firing into the memory worker.

`workflow-weekly-digest` is contested rather than clearly wrong: its input literally says
*"check context memory"*, and `admin`'s description is *"Business context, episodic memory…"*.
The agent did what the words said; the expectation says `research`.

---

## Corrected numbers

Stated in two tiers, because the difference between them is the difference between evidence
and a claim.

**Proven** — flipping only the seven D1 rows where the gated tool is the single expected tool,
changing no expectations:

| dimension | published | corrected |
|---|---|---|
| Tool selection | 15/30 · 50% | **22/30 · 73%** |
| Overall | 16/38 · 42% | **23/38 · 61%** |

**Projected** — if D1–D4 are all fixed (harness reads in-flight receipts, routing accepts a
worker anywhere in the plan, draft-vs-send expectations align with the July rule, direct reply
is a legal outcome): roughly **29/38 · 76%**.

And once D5 is fixed so the three recursion crashes count as the behavioural failures they
are, the honest denominator becomes 41: **≈29/41 · 71%**.

**Nothing in this document has been applied to the published `EVAL.md`.** The generated report
stays as the runner wrote it; these are the numbers a corrected harness would be expected to
produce, and they are worth exactly nothing until it is corrected and re-run.

---

## Ranked fix list

| # | fix | effort | score impact | why first |
|---|---|---|---|---|
| 1 | **Persist the plan + raw receipts in `Observation`** (D7) | S | none directly | every other diagnosis depends on it; without it the next run is another audit |
| 2 | **Read `state.step_receipts`; add `tool_receipts` to the `failed` branch** (D1) | S | +23 pts overall | largest single cause, proven |
| 3 | **Score routing against the whole plan** (D2) | S | +2 tasks | one-line change to a pure function |
| 4 | **Re-specify the 6 draft-vs-send tasks against the July rule** (D3) | M | +2 tasks | the eval currently penalises a deliberate prod fix |
| 5 | **Allow `expectedRoute: "direct"`** (D4) | S | +2 tasks | direct reply is the architecture, not a miss |
| 6 | **Narrow `isInfraError` to real infra shapes** (D5) | S | **−3 tasks** | makes the number honest, not higher |
| 7 | **Give the worker a convergence condition** (B5) | L | fixes 3 real crashes | the one genuine product bug here |
| 8 | **Fix the `admin` over-pull** | M | +2–4 tasks | the real capability gap |
| 9 | Add the `~/Desktop/report.pdf` fixture (D6) | S | +1 task | environment, not code |

Items 7 and the `adversarial-*` re-specification (B6) are already in flight as separate
sessions.

**Sequencing note:** do #1 before anything else, and re-run once after #1–#6 land. Fixing the
harness while blind to the plan is how this eval got into this state.

---

## The honest reading

A harness that quietly drops receipts from every approval-gated tool was always going to
report that a HITL-heavy agent doesn't call tools. The 50% tool-selection number was measuring
`kernel-invoker.ts`, not the kernel.

That is worth more as a portfolio artifact than a 90% would have been, on one condition: that
the corrected number is *earned by re-running*, not asserted here. Until then, 42% is the
published result and this document is the analysis of it.

See also: [EVAL.md](EVAL.md) · [LIMITATIONS.md](LIMITATIONS.md) · [`../EVAL.md`](../EVAL.md)
