# Netherlands AI Market — Pain Points, Targeting, and Positioning

_Date: 2026-07-29 · Owner: Pushkar Verma · Status: research complete, targeting not yet executed_

> **Evidence discipline.** Every claim below is tagged:
> **[V]** verified against a named source this session ·
> **[U]** unverified — from prior knowledge, must be checked before acting ·
> **[X]** corrected — an earlier claim that was wrong.
> Nothing here should be acted on at **[U]** without verification.

---

## 1. The corrected EU AI Act timeline

**[X] CORRECTION.** An earlier working assumption in this project was that high-risk
AI obligations become enforceable **2 August 2026**. That is wrong.

**[V] Actual position.** The **Digital Omnibus**, approved by the Council of the EU
on **29 June 2026**, postponed the high-risk deadlines:

| Obligation | Original | Revised |
|---|---|---|
| Annex III — standalone high-risk systems | 2 Aug 2026 | **2 Dec 2027** |
| Annex I — AI embedded in regulated products | 2 Aug 2027 | **2 Aug 2028** |

Sources: Gibson Dunn, "EU AI Act Omnibus Agreement — Postponed High-Risk Deadlines";
Cloud Security Alliance research note on the Omnibus deadline delay.

**[V] What high-risk systems will still require:** human oversight including stop
procedures, automatic logging, traceability, pre-deployment technical documentation,
conformity assessment, and ongoing risk management. Penalties up to €35M or 7% of
global revenue.

### Why the delay makes the positioning stronger, not weaker

A deadline four days out would mean the control-plane work is already done or
outsourced to compliance vendors. A deadline in **December 2027** means the build-out
is happening **now, through 2026–2027** — which is exactly the hiring window.

**Do not claim FounderOS is "EU AI Act compliant."** That is a legal conclusion
requiring conformity assessment, and asserting it is a credibility-killer with anyone
who actually knows the regulation. The accurate, defensible claim is narrower and
stronger:

> "I built an agent system where human oversight, automatic logging, and traceability
> are architectural defaults rather than features bolted on — the same control
> patterns the AI Act requires of high-risk systems."

### Control-to-obligation mapping (accurate, checkable)

| AI Act control theme | FounderOS mechanism |
|---|---|
| Human oversight | HITL on 17 gated tools; DB row written before `interrupt()` |
| Stop procedures | halt/resume commands; budget kill-switch |
| Automatic logging | `action_log`, `ai_call_costs`, audit row only on real success |
| Traceability | `ToolReceipt` per execution; typed `FailureReport` (stage·component·evidence) |
| Record integrity | content-addressed idempotency keys; no double-send |
| Risk management | per-run/per-day budget caps; path-guard; dangerous-command flagging |
| Reproducibility | Postgres checkpointing; byte-identical plans at temp 0 |

This mapping is the spine of the Dutch pitch. It converts engineering choices that
read as "nerd flex" into **procurement-relevant properties**.

---

## 2. Where Dutch AI companies are actually struggling

**[V]** Source: Techleap, *AI Scaling Challenges for Dutch Founders*. Four hurdles:

1. **Funding disconnect** — Dutch VCs lack "depth and width" of AI technical
   understanding; founders struggle to communicate their technology.
2. **Insufficient industry knowledge** — decision-makers and public figures lack AI
   expertise, producing *"unclear regulations, slow adoption by end-users, and
   negative media sentiment."*
3. **Restricted market access** — need access to joint research facilities and
   "clean, computational, and randomised datasets."
4. **Talent acquisition crisis** — *"Dutch AI founders struggle with attracting and
   retaining AI talent."* Recommendation includes increased international recruitment.

### Reading these as hiring leverage

- **#4 is the opening.** The stated remedy is *international recruitment* — which is
  the door a non-EU candidate walks through. This is not a market where employers are
  spoiled for choice.
- **#2 is the wedge, and it is the important one.** If buyers and decision-makers
  lack AI expertise, the binding constraint on adoption is **trust**, not capability.
  A candidate whose system *demonstrates* rather than *asserts* — receipts, approval
  gates, audit trails, honest failure reports — is selling directly into the stated
  problem. "Slow adoption by end-users" and "unclear regulations" are both trust
  failures, and FounderOS's architecture is a trust architecture.
- **#1 matters for interviews.** Founders themselves struggle to explain AI technology.
  Someone who can make an agent system *legible* — which is precisely what the
  Evidence Console does — is solving a problem the ecosystem has named out loud.

**Strategic conclusion:** lead with **trust, auditability and reliability**, not with
model cleverness. In this market that is both the differentiator and the pain point.

---

## 3. Market facts

**[V] Salaries (EuroTalent guide):** Junior 0–2y €50–68K · Mid 3–5y €68–100K ·
Senior 5+ €100–150K. Sector average €68K. Major hubs pay 10–20% above.

**[V] HSM thresholds 2026:** €5,942/mo (30+) · **€4,357/mo (under 30 — applicable)** ·
€3,122/mo (recent graduate). Confirmed applicable band: under 30, ≈€52.3K/yr.
⚠️ Figures are from third-party guides — **confirm at ind.nl before acting**.

**Consequence:** the under-30 threshold sits *inside* the junior band. Junior AI
engineer offers clear the visa bar. This is the single most important structural fact
in the plan.

**[V] Ecosystem (Techleap / Dealroom, State of Dutch Tech 2026):** 11,000+ tech
companies · €2.64B VC raised in 2025 · 95%+ English proficiency. Amsterdam is the
commercial/fintech/SaaS centre; **Eindhoven** dominates deeptech and semiconductors.

---

## 4. Targeting method (do this, in order)

The IND register is the hard filter. Everything else is secondary.

**[V] The register:** `https://ind.nl/en/public-register-recognised-sponsors/public-register-work`
— an HTML table of organisation name + KvK number, updated monthly (last update
1 July 2026). **No CSV, no API, no search tool.** Browser find only.

### Step 1 — Build the sponsor list locally
Scrape the register table into a local CSV (name + KvK). This is a legitimate use of
a public register and takes minutes. It becomes the authoritative filter.

### Step 2 — Cross-reference against AI employers
Intersect the sponsor list with companies that actually build AI/agent/ML platform
systems. Any company not in the intersection is not a target, regardless of appeal.

### Step 3 — Rank by fit to the thesis
Prioritise companies whose problem *is* reliability, governance, retrieval or
agent infrastructure — where the console is direct evidence rather than a nice extra.

### Step 4 — Verify each shortlisted company
Confirm: still on the register · currently hiring · role is genuinely AI-engineering
rather than data-analyst relabelled · English-working.

---

## 5. Candidate company clusters — **[U] ALL UNVERIFIED**

> These are hypotheses from prior knowledge, listed to give Step 2 a starting shape.
> **None has been checked against the IND register or for open roles this session.**
> Treat as a research queue, not a target list.

**Tier A — AI infrastructure (closest fit to the thesis)**
Weaviate (vector DB, Amsterdam) · Zeta Alpha (neural search, Amsterdam) ·
Deeploy (model governance/explainability, Utrecht) · Axelera AI (AI chips, Eindhoven — **[V]** named in Dealroom's top Dutch AI list)

Deeploy is worth attention: model governance and explainability is the commercial
form of exactly what the Evidence Console demonstrates.

**Tier B — Scale-ups with heavy AI platform needs**
Adyen · Booking.com · Mollie **[V]** · Mews **[V]** · Picnic · Backbase · Bird ·
Miro · Elastic · TomTom · Catawiki

**Tier C — Deeptech / research-adjacent (Eindhoven, Delft)**
ASML and its supplier ecosystem · Philips Research · university spinouts

**Tier D — Quant/trading (highest pay, hardest bar)**
Optiver · IMC · Flow Traders

**Next action:** convert this into a verified table with columns
`company · KvK · on-register? · AI roles open? · thesis fit · English-working? · applied?`

---

## 6. India — secondary funnel

**[V]** 1M+ AI positions projected by end-2026 vs ~120K trained AI professionals in
GCCs; roughly one qualified engineer per ten openings. Four roles every GCC hires
against: AI/ML, prompt engineering, MLOps, **platform engineering**. Entry ₹7L ·
Mid ₹15L (AI avg ₹18L) · Senior ₹28L. Contract hiring ~25% of GCC volume.
Tier-2 cities now 10–12%.

**[V] Screening is machine-first:** skills-graph encoding rather than job
descriptions; semantic sourcing across LinkedIn, GitHub, Stack Overflow and Naukri;
AI-led pre-screening at 400–600 candidates/week versus 40–60 manually.

**Consequence:** profiles are parsed by models before humans see them. Every surface
needs a machine layer (explicit skill tokens, crawlable pages, repo topics) as well
as a human layer. Maintain a Naukri profile separately for this funnel.

---

## 7. Positioning statement

> **I build the control plane for AI agents — the part that makes them safe to put in
> front of a business.** Human oversight, automatic logging, traceable receipts and
> honest failure reporting, running in production. My background is production
> backend engineering, which is why the agents don't fall over.

Lead label: **agent platform engineering** — the least crowded of the four GCC lanes
and the most defensible against a pure-ML candidate pool.

Do not use: "full-stack developer who learned AI."

---

## 8. Open questions

- Which Tier A/B companies are actually on the IND register? (Step 1–2, not yet done.)
- Does any Dutch employer explicitly ask for AI Act readiness in job specs? Worth
  scanning postings — if yes, the mapping in §1 goes at the top of the CV.
- Is a Dutch-language barrier real for any target, or is 95% English proficiency
  sufficient in practice?
