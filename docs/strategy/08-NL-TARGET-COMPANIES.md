# Netherlands — Verified Target Companies

_Date: 2026-07-29 · Source: IND public register of recognised sponsors (work), scraped 2026-07-29 · Register last updated by IND 2026-07-01_

**Data:** [`data/ind-sponsors-work.csv`](data/ind-sponsors-work.csv) — 12,883 organisations.
**Regenerate:** `node --import tsx/esm scripts/ind-sponsors.ts --match`

> **Every company below is confirmed present on the IND recognised-sponsor register**
> with its KvK number. That means it is *legally able* to sponsor an HSM permit.
> It does **not** mean it is hiring, hiring for AI, or hiring at junior level —
> those are per-company checks marked `☐` below.

---

## Why this list is the whole game

Only recognised sponsors can hire a non-EU candidate on a Highly Skilled Migrant
permit. Applying anywhere else is wasted effort regardless of how strong the portfolio
is. This register is therefore the **hard filter applied before all other targeting**.

12,883 organisations → 86 watchlist hits → the tiers below.

---

## Tier A — Agent / AI infrastructure (direct thesis fit)

These companies' *products* are the things the Evidence Console demonstrates.
The portfolio is not adjacent evidence here; it is on-topic evidence.

| Company | KvK | What they do | Why the fit is strong |
|---|---|---|---|
| **Deeploy B.V.** | 78193621 | ML model governance, explainability, monitoring | **Best fit on the list.** Their product *is* auditability and trust in ML. Receipts, audit rows, HITL gating and typed failure reports are their thesis expressed as architecture. |
| **Weaviate B.V.** | 75231824 | Open-source vector database | RAG is their business. Hybrid retrieval + reranking + RRF work maps directly onto their user problems. |
| **Zeta Alpha Vector B.V.** | 74985515 | Neural search / RAG for enterprise | Same retrieval domain; smaller team, so breadth (backend + infra + evals) is an asset not a dilution. |
| **AXELERA AI B.V.** | 82483027 | AI inference chips (Eindhoven) | Weaker fit — embedded/hardware rather than agent orchestration. Include only if they post a platform/software role. |
| **Dataiku B.V.** | 83000828 | Enterprise AI/ML platform | Platform engineering lane; governance and reproducibility are core selling points. |
| **Databricks** | 51208121 | Data + AI platform | Large, competitive, but the lane is exactly right. |
| **Snowflake Computing Netherlands B.V.** | 73059277 | Data cloud | Adjacent; strongest if they post an AI-platform role. |
| **DataSnipper B.V.** | 69343861 | AI for audit/assurance workflows | Audit domain — evidence, traceability and defensibility are the product. |
| **Xomnia B.V.** | 57245886 | AI/data consultancy | Consultancies hire generalist-depth profiles and move fast on sponsorship. |

## Tier B — Regulated / high-stakes AI (**the sharpest strategic angle**)

Medical AI falls under **Annex III high-risk** in the EU AI Act. These companies are
legally obliged to build human oversight, automatic logging, traceability and risk
management — with a **2 Dec 2027** deadline (see [07-NL-AI-MARKET-AND-TARGETING.md](07-NL-AI-MARKET-AND-TARGETING.md) §1).

For them, a control plane is not a nice-to-have engineering flourish. It is a
compliance requirement they must staff for, now, to hit that date.

| Company | KvK | Domain |
|---|---|---|
| **Pacmed B.V.** | 64013553 | Clinical decision support (ICU) |
| **Aidence B.V.** | 64531694 | Medical imaging AI (lung nodules) |
| **Castor International B.V.** | 17108188 | Clinical trial data platform |
| **Koninklijke Philips N.V.** | 17001910 | Health technology, large AI/ML org |

**This is the tier where the FounderOS architecture stops being "impressive engineering"
and becomes "the thing they are currently trying to hire for."** Prioritise accordingly.

## Tier C — AI-heavy scale-ups (volume + strong pay)

| Company | KvK | Note |
|---|---|---|
| Adyen N.V. | 34259528 | Payments; heavy platform/reliability culture |
| Booking.com B.V. | 31047344 | Largest NL tech employer; many AI/ML roles (multiple entities on register) |
| Mollie B.V. | 30204462 | Payments |
| Picnic Technologies B.V. | 68883471 | Logistics/ML optimisation |
| Backbase B.V. / R&D B.V. | 34192943 / 34274511 | Banking platform |
| bunq B.V. | 54992060 | Neobank, AI-forward |
| Bitvavo B.V. | 68743424 | Crypto exchange |
| TomTom International B.V. | 34076599 | Mapping/location AI |
| elasticsearch B.V. | 54656230 | Search infrastructure — good retrieval fit |
| Datadog Netherlands B.V. | 77823664 | Observability — strong fit for the tracing/metrics work |
| Bol.com B.V. | 32147382 | E-commerce, recsys |
| Coolblue B.V. | 24330087 | E-commerce |
| Catawiki B.V. | 01131735 | Marketplace, ML pricing |
| Mews Systems B.V. | 66426995 | Hospitality SaaS |
| SendCloud B.V. | 66572959 | Logistics SaaS |
| Otrium B.V. | 63996901 | Fashion marketplace, ML |
| Framer B.V. | 59920637 | Design tooling — strongest *frontend* signal target |
| GitLab B.V. | 60034831 | DevOps platform |
| MessageBird B.V. | 51874474 | CPaaS |
| Uber B.V. | 56317441 | Large ML org |
| Netflix International B.V. | 62266519 | Large ML org |
| Nedap N.V. | 08013836 | Technology, Groenlo |
| Exact Group B.V. | 27225828 | Business software |

## Tier D — Quant trading (highest pay, hardest bar)

| Company | KvK |
|---|---|
| Optiver Holding B.V. | 33186961 |
| IMC B.V. | 33212299 |
| Flow Traders B.V. | 33223268 |

Determinism, latency budgets and correctness-under-failure are cultural obsessions
here — the "9ms kernel overhead vs 14–32s model" measurement and byte-identical-plan
determinism proof land better with this audience than with anyone else on the list.
Bar is very high and they rarely hire at 3 years; treat as stretch.

## Tier E — Deeptech (Eindhoven)

ASML Holding N.V. (17085815) · ASML Netherlands B.V. (17052456) — plus the Brainport
supplier ecosystem, which is largely on the register and under-applied-to relative to
Amsterdam.

---

## Not on the register — do not target

Verified absent from the work register at time of scrape: **Miro · Orikami · AFAS**.
(Absence may mean a different legal entity name — worth one manual check before
writing a company off entirely.)

---

## Application tracker

Copy per company. Nothing below is verified yet.

```
company:            Deeploy B.V.
kvk:                78193621
on register:        ✓ verified 2026-07-29
☐ AI role open?
☐ junior/mid level? (must clear €4,357/mo HSM, under-30 band)
☐ English-working?
☐ office location / hybrid policy
☐ thesis fit note
☐ applied (date)
☐ response
```

## Recommended application order

1. **Tier B (regulated AI)** — the control plane is a legal requirement they must staff for.
2. **Deeploy, Weaviate, Zeta Alpha** — smallest teams, most direct product fit, fastest decisions.
3. **Datadog, elasticsearch** — observability/search, direct technical overlap.
4. **Tier C volume** — Booking, Adyen, Picnic, bunq.
5. **Tier D** — stretch applications only once the console is live.

## Caveats

- Register is a **point-in-time scrape (2026-07-29)**; IND updates monthly. Re-run
  the script before a serious application round.
- Presence on the register says nothing about open roles, level, or willingness to
  sponsor a specific candidate.
- Tier assignments and "fit" judgements are **mine, not verified market data** —
  they are hypotheses to test, and the `☐` checks above are the test.
- The 86 watchlist hits come from a hand-written name list, so the CSV certainly
  contains relevant AI employers this document misses. Grep the CSV directly when
  a new target surfaces.
