# AG-010 — Retrieval evaluation: golden set, recall@k, and the RAG triad

**Milestone:** eval infrastructure (audit fix #3 + limitation L4)
**Branch:** `feat/retrieval-eval` — cut from fresh `origin/main`. PR base: `beta`.
**Status:** dispatched
**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Goal

FounderOS can prove retrieval is **up**. It cannot prove retrieval is **good**. There is no golden
retrieval set, no recall metric, and no groundedness check anywhere in the repo — the only
relevance signal in the system is `src/db/rag-search.ts:88`, a `score` equal to the fraction of
query terms present, which its own comment calls "a rough relevance."

This is the highest-frequency question in a 2026 AI engineering interview and we have no answer.

**Done means:** `pnpm eval:retrieval` runs a fixed golden set of queries against `turicks_brain`,
scores **recall@5** and **MRR** against known-correct documents, and prints a report. Scoring is
**pure and unit-tested offline at $0**, exactly like the existing `pnpm eval` harness.

The RAG triad (faithfulness / answer-relevance / context-relevance) is **stage 2** of this brief —
see the phasing section. Do not start it before stage 1 is green.

---

## Measured starting state — verify these yourself before you begin

```bash
# Zero retrieval quality metrics exist anywhere
grep -rniE "recall@|ndcg|\bmrr\b|faithfulness|groundedness" src/ scripts/ tests/

# The only "relevance" signal in the system
sed -n '80,95p' src/db/rag-search.ts
```

| Measure | Value |
|---|---|
| Occurrences of `recall@` / `nDCG` / `MRR` / `faithfulness` in the repo | **0** |
| Existing golden-task count (behavioural, not retrieval) | **46** — `src/eval/golden-tasks.ts` |
| Allowed RAG tables | **3** — `personal_rag`, `turicks_brain`, `research_cache` (`src/db/rag-search.ts:13`) |

**One number I could not measure and you must:** the size of the `turicks_brain` corpus. My SSH to
`founderos-vps` timed out and the dev database does not hold the table. **Run this yourself and
paste the number into your PR body before writing a single golden query** — a 30-query golden set
is right for a 5,000-chunk corpus and meaningless for a 50-chunk one:

```bash
ssh founderos-vps 'sudo -n docker exec founderos-postgres psql -U founderos -d founderos -tAc "select count(*) from brain.turicks_brain;"'
```

If the corpus is under ~200 chunks, **stop and report** rather than authoring a golden set sized
for a corpus that does not exist.

---

## Files in scope

| Path | Change |
|---|---|
| `src/eval/retrieval-golden.ts` | **new** — the golden query set (data only, no logic) |
| `src/eval/retrieval-scoring.ts` | **new** — pure recall@k / MRR functions |
| `src/eval/retrieval-runner.ts` | **new** — injectable retriever seam |
| `scripts/run-retrieval-eval.ts` | **new** — CLI entry |
| `package.json` | add `eval:retrieval` script |
| `tests/unit/eval/` | tests for the scoring functions |

Nothing else. **Do not modify `src/db/rag-search.ts`, `src/tools/rag.ts`, or
`src/infra/rag-orchestrator.ts`.** This task measures retrieval; it does not change it. If the
measurement reveals retrieval is bad, that is a *finding to report*, not a fix to make here.

---

## The pattern to follow

**Copy the shape of the existing eval harness — it is already correct.** Read these three files
before writing anything:

- `src/eval/types.ts` — how a golden case declares its expectation
- `src/eval/scoring.ts` — **pure functions, zero I/O, fully unit-testable.** Note especially its
  "metric philosophy" header: each metric is computed only over cases that *declare* the relevant
  expectation, so the number means what it says. Hold that property.
- `src/eval/runner.ts` — the injectable `Invoker` seam that lets unit tests run at $0

Mirror that structure exactly: a `RetrievalGoldenCase` type, pure `recallAtK` / `meanReciprocalRank`
functions, and an injectable `Retriever` so tests never touch Postgres or Ollama.

**Golden case shape.** Each case needs a query and a set of document identifiers that a correct
retriever must return. Derive the expected docs from the real corpus — **do not invent document ids**.
Where a query has no unambiguously correct document, omit the case rather than guessing; a golden
set built on guesses measures nothing.

**Report the denominator.** Follow `src/infra/rag-optimization-sweep.ts` — read its header comment.
Its binding invariant applies here in full: *a check that did not run and a check that came back
clean must never look the same from outside.* If Ollama is down and the retriever silently
degrades to keyword-only (see `scripts/probe-rag.ts`), the report must say so on its face rather
than printing a recall number computed under degraded retrieval.

### Phasing — stage 1 must be green before stage 2

1. **Stage 1 (this PR):** golden set + recall@5 + MRR, offline-scored, unit-tested.
2. **Stage 2 (only after stage 1 is green):** the RAG triad — faithfulness, answer-relevance,
   context-relevance. These require an LLM judge. **Reuse `src/infra/judge.ts`**, which already
   runs on a different model family to avoid identity bias and already fails open. Do **not** write
   a second judge. If stage 1 runs long, ship it alone and say so — a merged stage 1 beats two
   half-finished stages.

---

## Explicitly forbidden

- **No paid API calls.** Unit tests use an injected fake retriever. If a live run is needed, use the
  free tier: `AGENT_MODEL=openrouter:google/gemini-2.5-flash-preview-05-20:free`. Running the live
  eval repeatedly during development is a budget violation.
- **No new vector-DB or eval dependency** (no ragas, no deepeval, no langsmith). Recall@k and MRR
  are ten lines of arithmetic each.
- **Do not change retrieval behaviour.** Measurement only.
- **Do not invent golden documents.** Every expected doc id must exist in the corpus you counted.
- No `any`, no `console.log` — `pnpm verify:arch` enforces both.

---

## Verify

Run and **paste raw output**:

```bash
pnpm lint && pnpm verify:arch && pnpm test
```

Then run the harness itself and paste the report:

```bash
pnpm eval:retrieval
```

In the PR body state: the measured corpus size, the number of golden cases, the observed recall@5,
and whether the run used real or degraded (keyword-only) retrieval. **If retrieval scores badly,
report the number honestly — a low recall@5 that we can now see is the deliverable. Do not tune
the golden set until the number looks good.** That would make the metric meaningless and is the
single worst outcome available for this task.
