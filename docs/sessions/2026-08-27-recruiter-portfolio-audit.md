# 2026-08-27 — recruiter-portfolio audit + first v3 golden-set eval

## What we did

Prepared the repo as a recruiter-facing portfolio piece (7-phase plan,
`~/.claude/plans/our-research-on-the-dreamy-curry.md`) and generated the three
live proofs it depends on.

- **Deleted confirmed dead weight**: `creative-engine/` (29 files, zero
  references from `src/`, superseded by the wired `video-factory/`), both copies
  of `eng.traineddata` (10.4 MB, no code references), and the committed
  `.superpowers/` runtime artifacts. Removed three zero-import dependencies
  (`@langchain/langgraph-supervisor`, `mem0ai`, `opossum`).
- **Fixed the README's headline diagram**, which still drew the v2
  supervisor→departments shape that the 2026-07-08 zero-base audit removed.
- **Curated `docs/decisions/README.md`** — 50 ADRs indexed, numbering collisions
  disambiguated (`028a/b/c`, `029a/b`), each tagged Current / Superseded /
  Historical, plus a ranked "start here" set of 10.
- **Ran all three proofs for real**: `proof:scoreboard` (3,611 tests green),
  `eval:retrieval` (published, §4), and `pnpm eval` (46 golden tasks, live model).

## What we fixed

- **`google-genai` judge provider was accepted but never constructed.**
  `src/infra/judge.ts` validated `google-genai` as a provider, then fell through
  to a keyless `ChatOpenAI` and failed with *"Missing credentials … OPENAI_API_KEY"*.
  Because the judge is fail-open, this surfaced as silently-missing scores, not
  an error. Same gap in `scripts/lib/content-judge.ts`. Both wired properly.
- **Extracted `src/infra/judge-model.ts`.** `judge.ts` sat at 398/400 lines, so
  the fix above pushed it to 406 and the LOC ratchet correctly refused the merge
  (`loc-budget: 7 (baseline 6) — NEW DEBT`). Split provider resolution out rather
  than raise the baseline: 406 → 325 + 100.
- **Dead nav link.** `docs/README.md` linked `phases/`, which has never existed
  in this repo. Repointed at `sessions/`. All 181 relative links now resolve.

## Why

Three model substitutions failed before the eval ran clean, and the reason is
worth recording because it cost three cycles:

**`gemini-flash-latest` — the single model pinned as production's `AGENT_MODEL` —
is degraded.** Measured directly, three calls each:

| model | result |
|---|---|
| `gemini-3.1-flash-lite` | 200 · 2.6s / 3.9s / 6.4s |
| `gemini-3-flash-preview` | 200 · 1.2s / 7.8s / 3.2s |
| `gemini-flash-latest` | 33.6s, then 2× hard timeout at 50s |

The error was reaching for a *free OpenRouter* model when the pinned Gemini
failed, instead of another Gemini. Free models hang past the 45s per-call
deadline (`MODEL_ATTEMPT_TIMEOUT_MS`) on agentic tool-calling loops, which then
looked like a deadline problem. It was not: the same logs showed
`Fallback model answered fallbackIndex:0` **two seconds** after each timeout —
Gemini answering fine as the fallback the entire time. Read the fallback lines
before blaming the timeout.

Also confirmed dead, by live probe: `meta-llama/llama-3.3-70b-instruct:free` and
`qwen/qwen3-next-80b-a3b-instruct:free` — **both** OpenRouter entries in prod's
`AGENT_FALLBACK_MODELS`, and the first is the hardcoded `JUDGE_MODEL` default.
The OpenRouter account also has a zero credit balance, so no paid slug there is
available as a substitute.

## Metrics

`pnpm eval` — 2026-08-27T15:19:35Z, planner+worker `gemini-3-flash-preview`,
fallback `gemini-3.1-flash-lite`:

| Dimension | Passed | Total | Accuracy |
|---|---|---|---|
| Routing | 28 | 38 | 74% |
| Tool selection | 15 | 30 | 50% |
| HITL coverage | 31 | 38 | 82% |
| **Overall** (conjunctive) | **16** | **38** | **42%** |

3 tasks excluded as infra errors by `isInfraError`.

Verified this is *not* a stale-harness artifact before publishing: the invoker
reads routes from the validated v3 plan (`steps[0].worker`), and v3's `WORKERS`
enum matches the eval's `Department` set exactly. The numbers are real.

Two findings from the run, both now in `LIMITATIONS.md`:
- **B5** — `Recursion limit of 25` kills open-ended research tasks. Raising the
  limit is the wrong fix; the workers lack a convergence condition.
- **B6** — `adversarial-prompt-injection` and `stress-dangerous-shell` score a
  *correct refusal* as a failure. Published unadjusted rather than re-scored.

Retrieval (`eval:retrieval`, 1,190 chunks / 37 queries): hybrid 97.3% recall@5 /
0.855 MRR, beating vector-only (86.5%) and keyword-only (83.8%). Reranking
measured at 94.6% / 0.885 but 9,579ms p95 — measured and **rejected**, not skipped.

`pnpm gate`: green, 329 files / 3,611 tests.

## Outstanding

1. `pnpm brain:sync` was **not** run — this worktree has no `.env`, so
   `DATABASE_URL` is unavailable. Must be run from the main checkout.
2. Prod `AGENT_FALLBACK_MODELS` still ends in two dead slugs, and
   `AGENT_MODEL=gemini-flash-latest` is still the degraded model. Prod is
   currently absorbing this via its Gemini fallback, at ~90s of wasted retry
   budget per affected turn.
3. B5 (recursion limit) and B6 (mis-specified adversarial tests) are open.
4. Nothing in this session was committed.
