# FounderOS — Ideation & Market Research

> **Type:** study / reference (read-only) · **Date:** 2026-06-04
> **Method:** 3 parallel deep-research agents (competitive landscape · realistic monetization ·
> reuse + job signal). Sources inline.

---

## The headline finding

**FounderOS is already a top-1% portfolio artifact. The bottleneck is legibility + distribution, not features.**

Three independent research agents converged on the same conclusion: no open-source project combines
business-domain supervisor routing + crash-safe DB-backed HITL + idempotency + deterministic eval
harness + path-guarded laptop operator, in TypeScript on Telegram. The "safe, evaluated,
budget-capped agent ACTIONS" positioning maps precisely to where OWASP Agentic Top-10 / NIST /
Microsoft Agent Governance converged in 2026. FounderOS shipped it a quarter early.

**Every new feature must pass the triple filter:** simultaneously (1) an **outcome**, (2) a **named
2026 hiring signal**, and (3) **mostly reuse** of what already exists.

---

## Competitive landscape

### Direct competitors (personal AI OS / AI chief-of-staff)

| Product | Traction | Gap vs FounderOS |
|---|---|---|
| **Lindy** | $49–199/mo, 3,000+ integrations, iMessage-first | No-code only; no HITL approval cards; no code/engineering dept; no open-source |
| **Embra** | ~$550K rev (bootstrapped) | Closest conceptually; no engineering dept; closed source; no HITL interrupt primitive |
| **Relay.app** | Early stage, G2 4.9/5 | No-code HITL workflow tool; no supervisor routing; no LLM agents |
| **OpenDAN** | ~2K⭐, Python, MVP | No HITL interrupt; no idempotency; no eval harness; IoT-lean; low activity |
| **OpenFang** | Very new, TS, daemon-style | Infrastructure-layer; no business-domain departments; no Telegram gateway |

**Observation:** no competitor combines the full stack. FounderOS is in an unoccupied niche.

### Indirect (infra, not products)

LangGraph (#2 agentic framework, 22.1% of job listings, $1.25B Series B), CrewAI (44K⭐, $18M),
n8n (100K⭐, $2B), Gumloop, Devin, OpenHands (61K⭐, SWE-bench 72%). These are frameworks or
vertical tools — not competing with FounderOS's personal-OS positioning.

### Whitespace a solo builder can own

1. **Production-LangGraph hardening starter (TS)** — HITL + idempotency + eval + LangSmith. None exists OSS.
2. **Telegram HITL-approval SDK for LangGraph** — Telegram is dominant in India/SEA/LatAm/Eastern Europe; zero well-starred OSS for Telegram + LangGraph + approval cards.
3. **Agent budget-guard npm package** — AI cost runaway is mainstream pain; no solo-focused TypeScript package ships per-run token/$ caps.
4. **Path-guarded personal laptop agent** reference impl — secrets blocked on read, HITL before write/shell/browser. Un-replicated.
5. **Supervisor eval harness pattern** — generic eval frameworks exist; none opinionated for supervisor routing + tool-select + HITL coverage.

*Sources: aifundingtracker, lindy.ai, getlatka (Embra), github (OpenDAN/OpenFang/OpenHands), OWASP
AI Agent Security Cheat Sheet, opensource.microsoft.com (Agent Governance Toolkit), jobsbyculture
(280% YoY agentic jobs), agentic-engineering-jobs.com (LangGraph 22.1% of listings).*

---

## Monetization reality

| Path | Realistic yr-1 (no audience) | Time-to-$1 | Build needed |
|---|---|---|---|
| **Productized DFY service** | **$25K–60K** | **4–8 wks** | **none — FounderOS IS the delivery infra** |
| **Starter kit on Gumroad** | $5K–12K (ProductHunt spike $1.5–7.5K) | 3–6 wks | ~20–40h packaging |
| **AI/agent engineering job** | $145–245K base (closes runway) | 2–6 wks | none — legibility only |
| Micro-SaaS hosted | $5K–12K | 3–6 months | 4–6 wks (auth/billing/multi-tenancy) |
| Open-core / GitHub Sponsors | $1K–5K | 6–18 months | distribution-bound |
| MCP marketplace listings | $500–1.5K | 3–6 months | discovery-bound |

### What earns vs hype

**Earns:**
- Productized DFY: 62% of first AI engagement clients convert to retainers within 6 months; average LTV $22K–33K (aibusiness.vc). Fastest cash, uses existing FounderOS infra.
- Starter kit: $79–149 one-time; ProductHunt launch can generate $1.5–7.5K in week one (empirical; Medium/Gumroad income data). Permanent lead magnet.
- The job: AI engineer $145–310K (Kore1, Acceler8); LangGraph in 22.1% of agentic job listings; AI Engineer = LinkedIn's #1 fastest-growing role.
- LinkedIn content (BUILD_LOG): drives both inbound leads AND job applications at 10.3% reply rate (outreaches.ai).

**Hype to ignore:**
- MCP marketplace revenue (17K servers, <5% earning; working-ref.com)
- "$60K/mo micro-SaaS" stories (median profitable micro-SaaS = $4.2K/mo; 30% never reach $1K; softwareseni.com)
- GitHub Sponsors without an existing community ($200–800/mo realistic early; calebporzio.com)
- Near-term YouTube AdSense (6–18 months to monetization threshold)

*Sources: indiehackers, softwareseni, medium (Gumroad), automatenexus, aibusiness.vc, outreaches.ai,
acceler8talent, kore1, digitalapplied (MCP).*

---

## Reuse before build (adopt, don't reinvent — TS/Node)

| Adopt | Gives you | Effort |
|---|---|---|
| **LangSmith** (already integrated) | Trace UI screenshots + per-step cost for portfolio; every `pnpm eval` run creates a shareable experiment | Done — start using it |
| **Langfuse** (self-host, MIT, free) | Self-hosted cost tracking + prompt versioning + shared trace links (run alongside LangSmith) | ~2h |
| **pgvector + `ts_tsvector` hybrid** | Production RAG on existing Postgres — zero new infra for real hybrid search | ~1 day |
| **Fastembed** (`@mastra/fastembed`) | Free, deterministic local embeddings for dedup and RAG tests | ~2h |
| **Braintrust** (TS SDK) | Dataset-first eval + CI gating, pairs with golden-task harness | ~1 day |
| **LiteLLM cost tables** | Accurate per-model $ data to enrich budget guard (no proxy needed) | ~2h |
| **FastMCP / Mastra MCP API** | Publish FounderOS tools as MCP server in 1–2 days | 1–2 days |
| **Promptfoo** (red-team) | Security-test path-guard against prompt injection | ~4h |

*Do NOT migrate to Mastra — mine it for patterns (memory compaction, MCP authoring). Sources:
speakeasy, gurusup, braintrust, arize, digitalapplied (MCP 97M downloads/month).*

---

## Meaningful feature menu (outcome-mapped, triple-filter)

### Legibility (highest job-ROI — mostly not code)

- **L1 — Make it legible:** committed EVAL.md numbers + per-run cost; LangSmith trace screenshots;
  post-mortem writeup; 90-sec Loom of Telegram HITL approval flow; architecture diagram in README.
  *Outcome: hardest-to-fake hiring signal made visible → interviews. Reuse: existing eval + LangSmith. ~1 week.*

### Job-signal features

- **J2 — MCP server** (search_web / send_email / github_r exposed via MCP). *Outcome: MCP-fluency signal
  (2026 hiring screen) + Claude Code/Cursor can drive FounderOS + distribution. Reuse: FastMCP. 1–2 days.*
- **J3 — Budget guard** (per-run token/$ cap + breach → Telegram). *Outcome: closes named take-home gap +
  real cost control; extract as `@founderos/budget-guard` npm. Reuse: LiteLLM cost tables. ~1 week.*

### Daily-use features (produce real data = validate the story)

- **F1 — Job-Hunt department** (personal-rag CV + search_web + HITL-drafted tailored applications).
  *Outcome: "FounderOS got me the job" validated story + future product. ADR-015 boundary: personal-rag
  read-only, never written to turicks-brain; never auto-submit forms or enter credentials. ~1–2 weeks.*
- **F2 — Real RAG** (pgvector + `ts_tsvector` hybrid over turicks-brain, Fastembed embeddings).
  *Outcome: better internal search + core-screened skill. ~1 day.*

### Revenue (reuse-first, fast cash)

- **R1 — Service outreach** via existing sales/marketing departments — no new code, 1 client in 6–8 wks.
- **R2 — LangGraph Production Starter kit** (extract supervisor+HITL+eval patterns) — Gumroad, $79–149.
- **R3 — `@founderos/budget-guard` npm** (extraction of J3) — permanent discoverability.

---

## What 2026 AI/agent engineering jobs actually screen for

**Must-haves (table stakes):** LLM API integration, tool/function calling, basic RAG, TypeScript or Python.

**Differentiators (separates hire from reject):**
- Multi-agent orchestration with explicit state management (LangGraph supervisor patterns)
- HITL design: where to interrupt, how to resume, DB-backed state, idempotency
- Eval harness: golden dataset, routing accuracy %, tool selection %, HITL coverage %, deterministic scoring
- Cost control: per-agent budget caps, model cascade fallbacks, token attribution
- Production observability: LangSmith/Langfuse traces, per-span cost, latency histograms
- MCP server authoring or MCP client integration

**Hardest to fake (signals that close offers):**
- A deterministic eval harness with published before/after numbers
- A post-mortem on a real production failure with root cause + fix
- HITL that actually gates real actions (email/LinkedIn/GitHub) — not mock
- Path-guard / blast-radius scoping with tested adversarial cases
- ADRs documenting what was decided NOT to do and why

**Portfolio artifacts that move recruiters:**
- README with: 1-line problem, architecture diagram, eval results table, one-command setup, ADR links
- LangSmith experiment link from a real golden-task run
- 90-second Loom: Telegram → HITL card → approval → action executes
- Committed `EVAL.md` with methodology (not just "it works")

*Sources: digitalapplied, theaicareerlab, jobsbyculture, agenticcareers.co, 2026 Stack Overflow
survey (84% of devs use AI, only 29% trust it — the trust gap is the product).*

---

## Related docs

- [`docs/study/SCALING-AND-PORTFOLIO-STRATEGY.md`](SCALING-AND-PORTFOLIO-STRATEGY.md) — earlier strategy (portfolio-as-product)
- [`docs/study/POSTMORTEM-eval-outputMode.md`](POSTMORTEM-eval-outputMode.md) — the eval harness bug post-mortem
- [`docs/decisions/014-job-first-public-ready.md`](../decisions/014-job-first-public-ready.md) — the sequencing ADR
- [`EVAL.md`](../../EVAL.md) — current eval results
