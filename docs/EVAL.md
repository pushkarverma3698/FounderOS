# FounderOS — How this system is evaluated

*Updated 2026-08-22. Every number here was produced by a command in this file.*

Most agent projects test that the code runs. This one tests that the **agent decides
correctly**, that it **says only what it did**, and that it **decides the same way twice**.
Those are three different failure modes and they need three different mechanisms.

---

## 1. The offline suite — behaviour, at $0

```bash
pnpm test        # 321 files · 3,499 tests · no network, no model spend
```

Models are **scripted**, not mocked-away. A `ScriptedModel` returns a fixed sequence of
completions, so the full kernel graph — plan → dispatch → worker ⇄ tools → collect →
synthesize — runs end to end in CI with zero paid calls. This is what makes it affordable to
assert on agent *behaviour* on every commit rather than once a milestone.

The cost discipline is a rule, not a habit: **no test may make a live model call.** A suite
that costs money per run gets run less, and a suite that gets run less stops being a gate.

---

## 2. Determinism — enforced in CI, not asserted in a README

`tests/unit/kernel/kernel-e2e.test.ts` builds the same kernel twice, invokes it with the same
input on two separate threads, and requires the plans to be **byte-identical**:

```ts
expect(JSON.stringify(a.mission.plan)).toBe(JSON.stringify(b.mission.plan));
```

Results are compared the same way with timestamps normalised, because a receipt's clock is
not a decision.

This holds because routing, parsing and the guards are **pure functions that are unit-tested
directly**, never prompt instructions. Temperature 0 helps; it is not the mechanism. The
architecture ratchet enforces the same thing structurally — `regex-routing: 0` in
`governance/architecture-baseline.json` means routing decisions cannot drift back into
pattern matching, and CI fails if the number rises.

> **Scope, stated precisely.** The determinism gate that runs on every commit is the kernel
> e2e test above, at $0. The 46-task golden set (`pnpm eval`) runs against a **live paid
> model** and is a manual milestone gate — it is *not* in `ci.yml`. Anyone reading
> "CI runs the golden set twice" elsewhere in this repo should read this paragraph instead.

---

## 3. The golden set — routing, tools, and the approval gate

```bash
pnpm eval        # 46 tasks, live model, paid — run once per feature
```

`src/eval/golden-tasks.ts` holds 46 fixed inputs. Each is scored on three independent
dimensions (`src/eval/scoring.ts`):

| Dimension | Question it answers |
|---|---|
| `scoreRouting` | did the planner send this to the right worker? |
| `scoreToolSelection` | did the worker reach for the right tool? |
| `scoreHitl` | did anything with a side effect stop at an approval? |

**A task passes only if all three pass.** Expectations are deliberately conservative and set
only where we are confident, so a failure is signal rather than an over-specified assertion
going off.

### The design decision worth stealing: infra failure is not a behaviour failure

```ts
export function isInfraError(obs: Observation): boolean {
  return typeof obs.error === "string" && obs.error.trim().length > 0;
}
```

A 503 that exhausted every retry and fallback is **not a routing miss**, and scoring it as one
corrupts the metric in the direction that matters: it makes the agent look worse the worse the
provider's day is, and it hides a real regression inside provider noise. Infra errors are
counted separately and excluded from behavioural scores.

This is not hypothetical. On 2026-07-13 a Gemini 503 storm failed 14 of 15 turns of a battery
test. Without this separation that reads as a catastrophic behavioural regression instead of
what it was — an upstream outage that the fallback chain then absorbed.

---

## 4. Retrieval — evaluated, not just wired

RAG is usually shipped and hoped for. Here it is measured (`src/eval/retrieval-golden.ts`,
`retrieval-scoring.ts`):

```bash
pnpm eval:retrieval
```

- **recall@5** — how many expected documents appear in the top 5
- **MRR** — how high the first correct document ranks

Both are scored **only over cases where retrieval returned something**, on the same principle
as `isInfraError`: a crashed query is not a recall miss. Results are also sliced by **authoring
style**, because a retriever that only works on documents written in one voice has a ceiling
nobody has measured yet.

The retriever itself is hybrid — pgvector semantic search fused with keyword search via
reciprocal rank fusion, then reranked (`src/db/rag-hybrid.ts`, `rrf.ts`, `rag-rerank.ts`).

---

## 5. Regression from incident — the cases that exist because something broke

The most damaging bugs this project hit **passed the unit suite while failing in production**,
because the suite exercised the kernel directly and never crossed the real Telegram gateway
seam. Every one of them is recorded in [SEAM-FAILURES.md](SEAM-FAILURES.md) with
signature → evidence → fix → prevention, and each fix ships with the regression test that
would have caught it.

| Incident | What broke | What now prevents it |
|---|---|---|
| **SF-1** | a *successful* tool result rendered as "⚠️ Tool issue" | seam-level assertion on the success path |
| **SF-2** | prompt injection leaked internal tool names | introspection guard + regression tests |
| **SF-3** | a thread parked mid-graph looped to the recursion limit forever | `isWedgedState` predicate + recovery guard at the top of every turn |
| **SF-4** | duplicate bot instance (EADDRINUSE / 409) | single-instance lock (`src/infra/single-instance.ts`) |
| **SF-5** | a reply from the previous turn shown as the answer to this one | turn-boundary slicing, asserted at the seam |
| **SF-6** | rejecting an approval card re-drafted forever | the reject path clears the thread and never resumes into the agent |

**Honest gap.** SF-3 and SF-6 were fixed in v2 modules that are now CI tombstones
(`office-run.ts`), so their entries name files that no longer exist. The *behaviours* are
still covered by tests in the v3 kernel — loop prevention and HITL reject are both in
`tests/unit/kernel/` — but the incident log has not been re-pointed at the current file
names. That is real debt and it is written down rather than tidied away.

**Second honest gap.** The 46 golden tasks were written as coverage of the route/tool/HITL
surface, not as a case-per-incident. So this table maps incidents to the regression tests that
cover them, which is true, rather than claiming each golden task descends from a production
failure, which is not.

---

## 6. What is *not* evaluated, and why that matters

A doc that only lists strengths is marketing. These are the real ceilings:

- **No latency or throughput assertion.** Nothing fails if p95 doubles. Cost is tracked per
  call in `ai_call_costs`; latency is not gated.
- **The golden set is not in CI.** It costs money, so it runs when someone remembers. A
  behavioural regression can therefore reach `main` and be caught later than it should be.
- **46 tasks is a small set.** It covers each route rather than each interesting input, and
  conservative expectations mean some real misses would score as passes.
- **No adversarial suite.** SF-2 produced one injection guard; there is no systematic
  red-team corpus behind it.
- **Retrieval golden cases are hand-authored**, so they inherit whatever blind spots their
  author had — which is exactly why they are sliced by authoring style.

---

## Reproducing any number on this page

```bash
pnpm test                 # 3,499 offline behavioural tests, $0
pnpm verify:arch          # the debt ratchet — may only shrink
pnpm eval                 # 46 golden tasks, live model, paid
pnpm eval:retrieval       # recall@5 and MRR over the retrieval golden set
pnpm proof:scoreboard     # regenerate docs/PROOF.md from a fresh run
```

### A note on the report file

`pnpm eval` writes its results to **`EVAL.md` at the repository root** — that file is
generated output, not prose, so it is never hand-edited. The copy currently committed is from
**2026-06-11** and predates the v3 kernel: it scores 29 tasks and asks "did the supervisor pick
the right department?", vocabulary for a graph tombstoned on 2026-07-08. It is left in place
rather than deleted because regenerating it needs a live paid run, and a deleted artifact and a
never-run one look identical. Treat it as a historical run until `pnpm eval` is run again.

This document — the method — is maintained by hand and is current.

See also: [PROOF.md](PROOF.md) · [LIMITATIONS.md](LIMITATIONS.md) · [SEAM-FAILURES.md](SEAM-FAILURES.md)
