# The 2026 AI-engineer market, measured from our own pipeline

*2026-08-28. Every number in §1–§5 comes from FounderOS's production database — first-party
postings its own job pipeline collected. §6 triangulates against published market research.*

**Why this document is unusual:** most job-market advice is written from surveys and recruiter
blog posts. This one is written from **911 real job descriptions** (avg 5,546 characters each)
that a system in this repository scraped, deduplicated, classified, and stored — and it is
reproducible with a SQL query. The measuring instrument is the portfolio piece.

---

## 1. The dataset

| property | value |
|---|---|
| Postings with full descriptions | **911** |
| Collection window | 2026-07-31 → 2026-08-27 (4 weeks) |
| Source boards | 623 ATS endpoints (Greenhouse, Lever, Ashby, Recruitee, Workday…) |
| Ingest runs | 890 |
| Mean description length | 5,546 chars |
| Table | `agents.job_applications` |

**By track** (classified by `classifyTrack`, not by title string):

| track | postings | with description |
|---|---|---|
| backend | 620 | 611 |
| **ai** | **177** | 172 |
| fullstack | 92 | 92 |
| frontend | 22 | 22 |

**By market:** India 625 · Netherlands 171 · unknown 100 · other 15.

### Read this caveat before quoting the growth curve

| week beginning | postings | of which AI-track |
|---|---|---|
| 2026-07-27 | 34 | 3 |
| 2026-08-03 | 133 | 23 |
| 2026-08-10 | 144 | 19 |
| 2026-08-17 | 254 | 56 |
| 2026-08-24 | 346 | 76 |

This is **not** clean evidence of market growth. The board registry expanded from 285 to 623
sources on 2026-08-20, which mechanically explains most of the step change in the last two
weeks. The honest reading: *our coverage* grew. Treat the ratios below as the signal and the
absolute weekly counts as an artifact of instrumentation.

---

## 2. What AI-track postings actually ask for (n = 177)

Percentage of AI-track postings whose description matches each term (case-insensitive, word
boundaries).

### Tier 1 — asked for by a third or more

| skill | postings | % |
|---|---|---|
| Python | 124 | **70.1%** |
| agent / agentic | 108 | **61.0%** |
| LLM (any mention) | 105 | **59.3%** |
| system design / architecture | 95 | 53.7% |
| stakeholder communication | 82 | 46.3% |
| scalability | 80 | 45.2% |
| REST / API design | 77 | 43.5% |
| AWS | 71 | 40.1% |
| production systems | 70 | 39.5% |
| testing | 70 | 39.5% |
| GenAI | 67 | 37.9% |
| Azure | 66 | 37.3% |
| security | 65 | 36.7% |
| **evaluation / evals** | **64** | **36.2%** |
| **RAG / retrieval-augmented** | **63** | **35.6%** |
| GCP | 60 | 33.9% |

### Tier 2 — the differentiators (10–33%)

| skill | postings | % |
|---|---|---|
| CI/CD | 58 | 32.8% |
| monitoring | 58 | 32.8% |
| ownership | 56 | 31.6% |
| mentoring | 51 | 28.8% |
| **observability** | 48 | 27.1% |
| vector database | 46 | 26.0% |
| Docker | 46 | 26.0% |
| **LangChain** | 45 | 25.4% |
| Kubernetes | 44 | 24.9% |
| embeddings | 43 | 24.3% |
| prompt engineering | 41 | 23.2% |
| Anthropic / Claude | 40 | 22.6% |
| latency | 32 | 18.1% |
| **LangGraph** | **32** | **18.1%** |
| OpenAI | 31 | 17.5% |
| fine-tuning | 28 | 15.8% |
| TypeScript | 28 | 15.8% |
| **MCP / Model Context Protocol** | **27** | **15.3%** |
| MLOps | 26 | 14.7% |
| **multi-agent** | 25 | 14.1% |

### Tier 3 — rare, and therefore high-leverage (< 12%)

| skill | postings | % |
|---|---|---|
| guardrails | 21 | 11.9% |
| tool / function calling | 16 | 9.0% |
| **human-in-the-loop** | **13** | **7.3%** |
| CrewAI | 13 | 7.3% |
| LLMOps | 12 | 6.8% |
| cost optimisation | 12 | 6.8% |
| autonomous agents | 12 | 6.8% |
| **hallucination** | 10 | 5.6% |
| reranking | 10 | 5.6% |
| pgvector | 6 | 3.4% |
| LangFuse | 4 | 2.3% |
| LangSmith | 4 | 2.3% |

**The strategic read.** Tier 1 is table stakes — everyone claims it, so it cannot differentiate.
Tier 3 is where a portfolio wins, because those terms appear in postings precisely when a team
has *already been burned* by an agent in production. A candidate with real HITL, guardrail,
hallucination-control and cost-attribution work answers a question the other applicants have
never been asked.

---

## 3. The stack that actually gets asked for together

Of 177 AI-track postings:

| combination | postings | share |
|---|---|---|
| mentions agents | 108 | 61% |
| agents **+** evaluation | 55 | 31% |
| agents **+** RAG | 54 | 31% |
| agents **+** evaluation **+** production | **35** | **20%** |

**One in five AI roles explicitly wants the triple: agents, evaluated, in production.** That is
the exact intersection FounderOS occupies, and it is a much narrower target than "knows
LangChain."

---

## 4. Seniority — the hardest finding in this dataset

Title keyword scan across all 911 postings:

| signal | postings | % |
|---|---|---|
| Senior | 286 | **31.4%** |
| Staff / Principal | 132 | **14.5%** |
| Lead | 71 | 7.8% |
| **Junior / Graduate / Intern** | **22** | **2.4%** |

Years-of-experience phrases inside AI-track descriptions: 8+ years appears in 40 postings,
5+ in 28, 3+ in 20, 1–2 in 31.

**Independent corroboration.** Published analysis of ~900 postings reports that 2.5% target
juniors with 0–2 years. Our pipeline, sampling different boards in a different month, measured
**2.4%**. Two independent instruments agreeing to within 0.1 points is the strongest validity
check in this document — and it is also the bleakest number in it.

**What follows from it.** The junior lane is effectively closed; ~46% of postings are
Senior/Staff/Principal. A portfolio cannot manufacture years of employment, but it *can* satisfy
the thing seniority is a proxy for: evidence of having operated a system in production, watched
it fail, and fixed it. That is the only lever available, and it is the one this repository
pulls. See [EVIDENCE-MAP.md](EVIDENCE-MAP.md).

---

## 5. Netherlands vs India — the two markets we actually sample

Share of AI-track postings mentioning each term, by country (NL n=34, IN n=119 AI-track):

| skill | NL | IN |
|---|---|---|
| agent / agentic | **70.6%** | 53.8% |
| Python | 61.8% | **68.9%** |
| evaluation | **38.2%** | 32.8% |
| Kubernetes | **35.3%** | 22.7% |
| RAG | 32.4% | 31.9% |
| observability | **29.4%** | 23.5% |
| LangChain | **29.4%** | 20.2% |
| TypeScript | **17.6%** | 11.8% |
| MCP | **17.6%** | 14.3% |
| **human-in-the-loop** | **14.7%** | 5.9% |
| LangGraph | 14.7% | 15.1% |
| fine-tuning | 14.7% | **18.5%** |

**The NL market is the better fit and it is not close.** Dutch postings over-index on exactly
the Tier-3 differentiators — agentic systems (+17 points), HITL (**2.5×**), observability,
Kubernetes, TypeScript. India over-indexes on Python and fine-tuning, which is a
model-centric rather than systems-centric profile.

### NL work-authorisation posture (n = 171 NL postings)

| sponsor verdict | postings |
|---|---|
| sponsor | 96 |
| uncertain | 44 |
| not-sponsor | 31 |

| salary gate | postings |
|---|---|
| pass | 102 |
| flag | 40 |
| reject | 29 |

**56% of sampled Dutch postings are from IND-recognised sponsors** and 60% clear the salary
floor on evidence. The 2026 HSM thresholds are €5,942/month gross for 30+, €4,357 for under-30
(excluding the 8% holiday allowance), both up ~4.5% on 2025. Reported Amsterdam AI-engineer
median compensation is around €109K — comfortably above the threshold, so at mid-to-senior
level the salary floor is not the binding constraint. (Note for planning: the 30% ruling steps
down to 20% in 2027 and 10% in 2028.)

---

## 6. What employers say in their own words

Requirements paraphrased from postings in the dataset — these are the sentences that read like
a specification for this repository:

- **Adyen** (ML Engineer II, AI) — wants proven experience operating agentic systems at scale:
  multi-agent orchestration, tool use, memory and context management, state handling for
  long-running workflows, and **human-in-the-loop design**.
- **Aera Technology** (AI/ML Engineer) — wants someone who has already shipped autonomous agents
  to production, seen them fail in ways a demo never surfaces, and built the **evaluation and
  guardrails** that made the second attempt trustworthy.
- **Experian** (Senior Staff Engineer, AI) — agentic orchestration, lifecycle management, memory
  patterns, runtime policy, and **human-in-the-loop controls**.
- **Reltio** (Sr. AI Engineer) — secure **MCP**/API-style tools exposing enterprise data and
  actions to LLM workflows with explicit schemas, **guardrails and audit trails**.
- **IFS** (Applied AI Engineer) — a security layer covering **prompt-injection resistance**,
  personal-data handling, guardrails and audit.
- **Flow Traders** (AI Engineer) — agents that plan, reason and execute multi-step workflows;
  reusable agent patterns other teams build on.
- **PwC** (AI Engineer, Senior Associate) — LLM agent workflows built on LangChain, **LangGraph**
  or CrewAI, with CI/CD.
- **Capco** (AI Engineer) — multi-agent orchestration, RAG pipelines, memory management, and
  **observability via Langfuse**.
- **LangChain** itself is hiring an AI Engineer in **Amsterdam** — the framework vendor is a
  local employer.

Four of these nine name human-in-the-loop, guardrails, or audit trails as a *requirement*.
That is the market asking for the thing this repo is built around.

---

## 7. External triangulation

Published signals, kept separate from our own measurements because their provenance is weaker:

- **Stanford AI Index 2026** — US postings mentioning agentic systems rose from 151 (2024) to
  over 16,500 (2025); reported as the sharpest single-skill demand shift the index tracked.
- **LinkedIn Jobs on the Rise** — AI engineering roles up ~143% year over year.
- Recruiting-industry estimates put agentic-AI posting growth near 280% YoY and US base
  compensation at roughly $185K–$320K. **Discount these**: staffing firms have a commercial
  interest in signalling a tight market. The Stanford and LinkedIn figures are the ones with
  independent provenance.
- Consistent across sources: hiring managers screen **production evidence before credentials** —
  latency, cost, reliability outrank model metrics, which outrank framework familiarity, which
  outranks degrees. RAG is described as the dominant enterprise pattern, and missing
  vector-database/embedding/reranking vocabulary is named as the most common mid-level résumé gap.
- Also consistent, and unfavourable: entry-level technical hiring is contracting sharply while
  senior AI demand grows. Our 2.4% junior share is the same story from a different sample.

---

## 8. What this means for positioning

1. **Target the Netherlands first.** It over-indexes on every differentiator we hold, 56% of
   sampled postings are from recognised sponsors, and the salary floor is not binding at
   mid-senior level.
2. **Lead with the Tier-3 vocabulary, not Tier 1.** Everyone writes "Python, LLM, RAG". Almost
   nobody can show a HITL gate that has rejected 36 real actions in production.
3. **Aim at the 20% intersection** — postings wanting agents + evaluation + production — rather
   than the 61% that merely say "agent".
4. **Do not apply as a junior.** The junior lane is 2.4% of the market. Apply against the
   evidence, which is a production system, not against a year count.
5. **Close the Python gap explicitly** (see [PORTFOLIO-GAPS-AND-ACTIONS.md](PORTFOLIO-GAPS-AND-ACTIONS.md)).
   Python appears in 70.1% of AI postings; this codebase is TypeScript. That is the single
   largest measured mismatch between what we have and what the market asks for.

---

## Reproducing this study

```bash
ssh founderos-vps 'sudo -n docker exec -i founderos-postgres psql -U founderos -d founderos' < scripts/sql/market-skill-frequency.sql
```

The queries are committed at [`scripts/sql/`](../../scripts/sql/) so every table above can be
regenerated against current data rather than trusted.

**Sources for §5–§7:** [Stanford AI Index / agentic posting growth](https://jobsbyculture.com/blog/agentic-ai-hiring-boom-2026) ·
[AI engineer demand 2026](https://www.futureproofing.dev/resources/ai-talent-gap/ai-engineer-demand-2026) ·
[What AI companies are hiring for](https://recruitslab.com/what-ai-companies-are-hiring-for-2026) ·
[AI engineer resume / RAG gap](https://levstack.io/en/blog/ai-engineer-resume-2026/) ·
[LLM engineer hiring bar](https://genai.qa/blog/hire-llm-engineer-salary-skills-interview-2026/) ·
[NL HSM salary thresholds 2026](https://www.jobbatical.com/blog/netherlands-highly-skilled-migrant-salary-thresholds-2026) ·
[NL AI salary bands](https://zenvanriel.com/job/ai-engineer-salary-netherlands/) ·
[KPMG on 2026 NL income requirements](https://kpmg.com/xx/en/our-insights/gms-flash-alert/2026/flash-alert-2026-004.html)
