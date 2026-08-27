# 2026-08-28 — AI-engineer market study from first-party data + portfolio readiness

## What we did

- **Merged the three open PRs** (#580, #581, #582) into `beta`, serially, each after a branch
  update and a fresh CI pass. Zero open PRs remain.
- **Measured the 2026 AI-engineering market from FounderOS's own production database** — 911 job
  postings with full descriptions (avg 5,546 chars), collected 2026-07-31 → 2026-08-27 across
  623 ATS boards. 92 skill terms counted with word-boundary regex over `agents.job_applications`.
- **Triangulated against published research** (Stanford AI Index, LinkedIn Jobs on the Rise, NL
  IND thresholds) and kept the two provenances separate.
- **Wrote a four-part study folder** in `docs/study/`: the market research, an evidence map
  (requirement → mechanism → file → production number), a ranked action list, and an interview
  brief.
- **Committed the SQL** to `scripts/sql/` so every published table regenerates instead of being
  trusted.
- **Rewrote the root README's top fold** into a six-number "Proof, in production" block.

## What we fixed

- **The root README led with narrative, not evidence.** A recruiter reads one screen. It now
  opens with 229 production approvals (36 rejected), 80 executed side effects, 1,843 LLM calls at
  $0.0014 mean, 3,611 tests at $0, 97.3% recall@5, and the CI debt ratchet — each reproducible.
- **`docs/EVAL.md` claimed 46 golden tasks in six places; `pnpm eval` runs 41.** The other 5 are
  `CREATIVE_GOLDEN_TASKS`, opt-in and never executed. Corrected — this was an error published
  yesterday.
- **Linked the eval audit** from `docs/EVAL.md` §3 and `docs/README.md`.

## Why

**The measurement is the portfolio piece.** Most job-market advice comes from surveys. This study
is derived from postings the repository's own pipeline scraped, classified and stored — so the
market analysis and the engineering artifact are the same object. That framing is worth more than
either half alone.

**Two findings changed the recommendation:**

1. **The binding constraint on getting hired is not the portfolio.** The funnel is
   `911 screened → 61 NL sponsor-verified + salary-clear → 22 tailored CVs → 2 applications`.
   Fifty-nine qualified roles have never been applied to. This is rule #26's failure mode
   recurring: a pipeline that screens flawlessly and produces nothing to act on. Every action in
   `PORTFOLIO-GAPS-AND-ACTIONS.md` is ranked against that, and the portfolio work is explicitly
   *not* the top item.

2. **The CV tailoring guard is a prompt instruction, not a mechanism.**
   `src/tools/jobhunt/tailor-cv.ts:43-44` forbids fabrication in the prompt; the only
   post-generation check is `findSlop`, a style linter. There is no claim-vs-base-CV
   verification, and 22 tailored CVs already exist. This directly violates the repo's own
   invariant — *"guards are pure unit-tested functions, never prompt instructions"* — in the one
   place a hallucination reaches a real employer. Flagged P0-blocking; **not built**, because it
   wasn't in scope and it gates real outbound applications.

## Metrics

**Market (n = 177 AI-track postings):** Python 70.1% · agent/agentic 61.0% · LLM 59.3% ·
evaluation 36.2% · RAG 35.6% · observability 27.1% · LangChain 25.4% · **LangGraph 18.1%** ·
TypeScript 15.8% · **MCP 15.3%** · multi-agent 14.1% · guardrails 11.9% · **HITL 7.3%** ·
hallucination 5.6% · pgvector 3.4%.

**Co-occurrence:** 108 postings mention agents; 55 agents+eval; **35 agents+eval+production
(20%)** — the intersection this repo occupies.

**Seniority:** Senior 31.4%, Staff/Principal 14.5%, **Junior/Grad 2.4%** across 911 postings —
matching a published 2.5% figure from an independent ~900-posting sample to within 0.1 points.
Two instruments, different boards, different month.

**NL vs India:** NL over-indexes on agents (70.6% vs 53.8%), HITL (**2.5×**), observability,
Kubernetes, TypeScript. India over-indexes on Python and fine-tuning. 96 of 171 NL postings are
from IND-recognised sponsors.

**Production numbers verified today:** 229 HITL approvals (131 approved / 36 rejected / 37
expired) since 2026-06-16 · 80 executed side effects · 1,843 LLM calls, $2.5298 total, $0.001373
mean, 8 models · 890 job ingest runs · 1,214 brain chunks · 330 evolution findings.

**Repo scale:** 334 src `.ts` files / 57,688 LOC · 337 test files / 3,611 tests · 51 tool modules
· 51 ADRs. `pnpm gate` green, exit 0.

## Outstanding

1. **P0 — build `verifyCvClaims()`** (~40 lines, pure, unit-testable) and re-verify the 22
   existing tailored CVs. Blocks scaling applications.
2. **P0 — apply to the 59 unapplied qualified NL roles**, 13 AI-track first. Founder action.
3. **P1 — fix the eval harness** per [EVAL-AUDIT-2026-08-28.md](../EVAL-AUDIT-2026-08-28.md),
   then re-run once so the corrected number is earned rather than projected.
4. **P1 — Python client + eval package for the MCP surface.** Python is 70.1% of postings and the
   largest measured gap; a rewrite is explicitly rejected as the wrong fix.
5. `pnpm brain:sync` still not run — this worktree has no `.env`/`DATABASE_URL`.
