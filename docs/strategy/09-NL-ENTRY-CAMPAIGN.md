# Netherlands Entry Campaign — Operating Plan

_Date: 2026-07-29 · Supersedes the sequencing in `docs/plans/2026-07-29-evidence-console-and-hiring-thesis.md` (amendment A11)_

**Constraints as confirmed by the founder, 2026-07-29:**

| Constraint | Value | Consequence |
|---|---|---|
| Location | India (returned from NL) | Needs employer sponsorship **and** an MVV. The IND recognised-sponsor register is a hard filter. |
| Age | 28 (DOB 1998-06-03) | Under-30 HSM band applies **until 3 June 2028**. |
| Salary floor | **€4,357/mo gross, excl. 8% holiday allowance** `[V]` ind.nl | = **€52,284/yr base**, ≈ €56,467 with holiday allowance. |
| Time available | **1–2 hrs/day** | Automation is not an optimisation. It is the only way the volume happens. |
| Priority | Job-search machine first | Benchmark continues as background. Console cut. |

---

## 1. The honest assessment

This is the hardest applicant category there is: non-EU, currently outside the EU,
requiring both sponsorship and an MVV, with 3.3 years of experience and a humanities
degree, competing against EU candidates who need no paperwork at all.

That is not a reason to stop. It is a reason to **stop pretending cold applications
alone will work.**

Rough funnel for this profile — **estimated, not measured**, and the campaign's first
job is to replace these guesses with real numbers:

```
100 cold applications → 5–10 recruiter screens → 2–3 technical → 0–1 offers
```

Which means 300–500 quality applications over 6–12 months, or a materially better
channel. At 1–2 hrs/day, 500 manual applications is arithmetically impossible.
**Therefore the machine is the strategy, not a convenience.**

### The deadline that actually matters

**3 June 2028.** Before it, an employer needs €4,357/mo to hire him. After it,
€5,942/mo — a 36% jump that moves him from "affordable mid-level hire" to
"needs to clear a senior budget line". Every month of delay is a month closer to
being 36% more expensive to employ.

---

## 2. Channels, ranked by honest expected value

### 1. Remote-first bridge — **highest conversion, currently unexploited**

Contract remotely with a Dutch or EU company as an Indian contractor. No visa
required. Deliver for 6–12 months. Then ask for sponsorship.

**Companies sponsor people they already trust.** Converting an existing, proven
contractor is a fundamentally easier internal argument than importing an unknown
mid-level engineer from another continent. It also solves the income gap in the
meantime, which cold applications do not.

This was absent from every earlier version of the strategy. It should be the
primary channel.

### 2. Open-source contribution to target companies

**Weaviate is open source. LangGraph JS is open source.** A merged PR is
simultaneously a work sample, a referral generator, and a warm introduction to the
actual engineering team — at a cost of hours, not weeks.

LangGraph JS specifically: he is among a small number of people running it in
production with contract validation and crash-safe HITL. Contributing there is
directly on-thesis and the maintainers are reachable.

### 3. The benchmark as inbound

Published harness → technical communities → people arrive already convinced.
Low probability per attempt, asymmetric payoff, near-zero marginal cost once built.

### 4. Automated cold applications at volume

The baseline. Only viable because it is automated.

### 5. Relocation-specialist recruiters

Cheap to set up; they do the sourcing. Set up once, then passive.

### Cut

**Evidence Console** (3 weeks for something recruiters will not open) ·
**hosted agent run** (cost and security risk, negligible hiring return) ·
**12-chapter LinkedIn thesis** (write three) ·
**Tier D quant** (will not sponsor at 3 years).

---

## 3. The machine

`jobhunt` worker already exists (`src/agents/capabilities.ts:96`) with `read_cv`,
`search_jobs`, `send_email` (HITL-gated), `search_personal_rag`. `search_jobs`
(`src/tools/career.ts:145`) is currently a thin web-search wrapper.

Missing — and this is the build:

| Component | Purpose |
|---|---|
| Sponsor-register filter | Reject any posting from a company not in `ind-sponsors-work.csv`. Non-negotiable hard gate. |
| Salary floor filter | Reject anything below €52,284 base. An employer legally cannot hire him below it, so applying is pure waste. |
| Application state table | Dedupe, track stage, schedule follow-ups. Without it the machine re-applies and embarrasses him. |
| Fit ranking | CV-to-JD semantic match via existing personal-rag embeddings. |
| Draft generation | Per-company cover letter grounded in real CV facts + company research. |
| Telegram approval queue | He taps approve. This is the entire 15-minute daily human step. |

**The machine is also the portfolio.** A system that ran its own job search, with
receipts, is a better demonstration than any dashboard — and it is dogfooding, which
is the single most credible thing an agent engineer can show.

---

## 4. Weekly rhythm at 1–2 hrs/day

| When | What | Human time |
|---|---|---|
| Daily 08:07 | Job sweep → filter → rank → draft → approval queue | 15 min (approve/reject) |
| Mon 09:12 | Pipeline review: what moved, what went silent, follow-ups due | 20 min |
| Wed 18:07 | OSS contribution block — Weaviate / LangGraph JS | 60 min (the highest-leverage hour of the week) |
| Fri 17:12 | LinkedIn post drafted from the week's real commits | 15 min (edit + post) |
| Sun 10:07 | CV re-research and rewrite against the week's market evidence | 30 min |
| 1st of month | Re-scrape IND register (IND updates monthly); refresh salary benchmarks | 10 min |

Total: **~6 hrs/week human**, inside the 1–2 hrs/day budget, with the machine doing
the sourcing, filtering, ranking and drafting.

---

## 5. Realistic timeline

| Phase | Window | Outcome |
|---|---|---|
| Machine build + first applications | Aug 2026 | Pipeline live, applications flowing daily |
| Volume + OSS + benchmark published | Sep–Nov 2026 | Real funnel numbers replace the estimates above |
| Interviews and offers | Dec 2026 – Mar 2027 | First offers likely in this window |
| MVV + IND processing | +2–3 months after offer | IND decision, MVV collection, relocation |
| **Arrival in NL** | **Q2–Q3 2027** | |

Stated plainly because the founder asked for reality: **this is a 9–12 month campaign,
not a 6-week one.** The remote-bridge channel is the main lever that could compress it.

---

## 6. What is not yet verified

- The funnel conversion rates in §1 are **estimates**. The application tracker's first
  job is to replace them with measured numbers.
- Tier assignments in [08-NL-TARGET-COMPANIES.md](08-NL-TARGET-COMPANIES.md) remain
  hypotheses, not market data.
- Whether any specific target company sponsors **at mid level** is unverified per
  company. Register presence proves legal capability, not willingness.
- The partner-permit route (via spouse's Zoekjaar) remains available as an alternative
  path and would remove the sponsorship filter entirely — worth re-costing if the
  spouse's status changes.

---

## 7. Employment-history items needing the founder's decision

- **Gap Jun 2025 – Nov 2025** (HFN end → Contact_ME start) is unexplained on the CV.
  Recruiters ask. Decide the honest one-line answer and use it consistently.
- **Contact_ME wage dispute** (₹1,63,955, complaint filed 2026-02-04). If unresolved,
  decide in advance how reference checks are handled.
- **Turicks is self-employment.** Legitimate, but Dutch recruiters read it as a gap
  unless framed as client delivery with named sectors — which the master CV now does.
