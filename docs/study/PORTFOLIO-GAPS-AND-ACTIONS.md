# Gaps and actions — ranked by what actually moves hiring

*2026-08-28. Measured against [MARKET-2026-AI-ENGINEER.md](MARKET-2026-AI-ENGINEER.md) and
[EVIDENCE-MAP.md](EVIDENCE-MAP.md).*

---

## Before the list: the binding constraint is not the portfolio

The brief was "make FounderOS portfolio-ready." The portfolio is already strong — the evidence
map shows it clears Tier 1 and holds four of the rare Tier-3 differentiators. So it is worth
saying plainly what the production data says instead:

```
911 postings screened
  ↓
 61 Netherlands roles that are sponsor-verified AND clear the salary floor
  ↓
  6 tailored CVs actually rendered (16 more attempts failed before rendering)
  ↓
  2 applications sent            ← lifetime, across the whole pipeline
```

*(Corrected 2026-08-28 — see the note in P0-1 below. The figure "22" published in this
document on 2026-08-27 conflated `tailor_status IS NOT NULL` — 6 successes + 16 failed
attempts — with the count of CVs that actually rendered. Only 6 real tailored-CV PDFs have
ever existed in production.)*

**59 of 61 qualified, sponsor-checked, salary-clearing Dutch roles have never been applied to.**
Thirteen of the 61 are AI-track. A portfolio improves the conversion rate of applications that
get sent; it cannot improve the conversion rate of applications that don't.

This is the exact failure this codebase's own rule #26 was written about — a pipeline that
screens flawlessly and produces no applications. It recurred.

**Live and unapplied right now** (NL, sponsor-verified, salary-clear, discovered in the last
week): KPN *ML Engineer* · Helloprint *Senior AI Engineer* · experlogix *AI Data Engineer* ·
FutureWhiz *Medior AI Product Engineer* · Databricks *Gen AI Solutions Architect* · Plumerai
*Deep Learning Research Engineer* · Altura *Senior Backend Engineer* · Tract *Senior Fullstack
Engineer*.

Everything below is ranked against that.

---

## P0 — Blocking, do before anything else

### 1. The CV tailoring pipeline could fabricate credentials — **FIXED 2026-08-28**

`src/tools/jobhunt/tailor-cv.ts` protected against fabrication with **prompt instructions
only** (lines 43–44: never invent titles, employers, dates, degrees; never claim untouched
skills). The only post-generation check was `findSlop` — a *style* linter. There was **no
verification that a claim in the tailored CV appears in the base CV**, which violated this
repository's own core principle (CLAUDE.md: *"guards are pure unit-tested functions, never
prompt instructions"*).

**Fixed by [PR #584](https://github.com/pushkarverma3698/FounderOS/pull/584):**
`verifyCvClaims()` (`src/tools/jobhunt/cv-claim-guard.ts`) — a pure, unit-tested function
checking five claim types (technologies, employers, titles, dates, degrees) against the base
CV, wired into `tailorCv()` so a fabricated claim now blocks the tailoring output instead of
shipping it.

**The retroactive audit — run 2026-08-28, read-only, against real production data:**
the "22 tailored CVs" figure in the original finding was wrong — that counted `tailor_status
IS NOT NULL`, which includes 16 attempts that *failed* before ever rendering a CV. Only **6**
tailored-CV PDFs have ever actually existed in production. Running the new guard against all
6 (via `pdf-parse` to extract text from the stored PDFs, since the raw markdown is never
persisted separately):

**6 of 6 flagged.** Confirmed fabrications include the exact terms from the original
2026-08-25 measurement (Kubernetes, C#, Domain-Driven Design) plus new ones (Vector Database,
ETL, Microservices, Distributed Systems) not present anywhere in the base CV. **None of the 6
have been applied to yet** (`applied_at` is null on all 6) — the fabrication risk was real but
contained; nothing fabricated has reached a real employer through this path. The 2 applications
sent to date used a different lane and are not implicated by this specific audit.

**Action required from the founder:** do not approve sending any of these 6 as-is. Re-run
`tailorCv()` for each — the new guard will now either produce a clean CV or refuse and name
the specific ungrounded claim.

**Why it's also the best interview story available:** "I found my own system's most important
guard was a prompt, not a function, in the one place a hallucination has legal consequences —
audited it against real production data, found the fabrication rate was 100% on what actually
shipped, confirmed nothing fabricated had gone out yet, and fixed it with the same mechanism
the rest of the kernel uses." That is Tier-3 (hallucination control, 5.6% of postings)
demonstrated on a real, measured stake — not a hypothetical one.

### 2. Send the 59 applications

Not a code task. `/apply` and the tailoring lane already exist and are live-verified. With
P0-1 landed, the constraint becomes founder time, which is what the pipeline was built to
remove. **Target: 13 AI-track roles first**, then the 40 backend.

---

## P1 — Highest portfolio leverage

### 3. Fix the eval harness, then re-run

The published golden-set score is 42%. [The audit](../EVAL-AUDIT-2026-08-28.md) proves at least
15 of 25 failures are harness defects — the invoker discards tool receipts from any step that
pauses at a HITL gate, so a HITL-heavy agent is measured by an instrument blind to HITL.

**Why this is P1 and not P2:** 36.2% of AI postings ask for evaluation, and a *published 42%*
is worse than no number at a glance. Fix the harness (small, pure-function changes), re-run once
(~$1), and the same document becomes the strongest artifact in the repo: a harness that caught
its own bug, with the corrected number **earned rather than asserted**.

Sequence: persist the plan in `Observation` → fix receipt collection → fix routing scoring →
re-specify the stale expectations → narrow `isInfraError` → re-run.

### 4. Close the Python gap — the largest measured mismatch

Python appears in **70.1%** of AI-track postings. This codebase is TypeScript (15.8%). No
amount of architecture quality resolves a keyword screen.

**Do not rewrite anything.** The cheapest honest fix is a **Python client + eval harness for the
MCP surface** — a small, well-tested Python package that talks to `src/mcp/`, runs the retrieval
eval, and publishes recall@5/MRR. That is:

- genuinely useful (the MCP server is real and read-only),
- idiomatic Python with tests (the screen passes on substance),
- and it demonstrates MCP (15.3%) **and** evals (36.2%) **and** Python in one artifact.

Explicitly *not*: porting the kernel, or a toy notebook.

### 5. Rewrite the README top fold for a 60-second scan

The README is strong but front-loads narrative. A recruiter reads the first screen and clicks
one link. See [INTERVIEW-BRIEF.md](INTERVIEW-BRIEF.md) §1 for the numbers that should be above
the fold: 229 production approvals (36 rejected), 80 real side effects, 3,611 tests at $0,
97.3% recall@5, $0.0014 mean cost/call, CI-enforced debt ratchet.

---

## P2 — Real gaps, lower leverage

### 6. Kubernetes (24.9%) and hyperscaler (34–40%)

Runs on Hetzner + systemd + Docker. Honest and defensible — *"one VPS, 229 approvals, no
outages"* is a fine answer — but it fails keyword screens.

**Cheapest credible fix:** a working `k8s/` manifest set (Deployment, Service, Secret,
readiness/liveness probes wired to the existing `health.ts`) plus a short doc on why prod
still runs systemd. Deploying it is optional; having designed it truthfully is what the JD is
proxying for. **Do not claim production Kubernetes.**

### 7. Golden set not in CI

Costs money, so it runs manually, so behavioural regressions can reach `main`. Named already in
`docs/EVAL.md` §6. A cheap middle path: run the golden set on a **schedule** (weekly) rather than
per-commit, with the report committed.

### 8. LangFuse / LangSmith (2.3%)

Low demand; first-party telemetry already covers it. **Recommend not doing this** — it would be
resume-driven development, and the measured demand doesn't justify it.

---

## Explicitly not recommended

| tempting | why not |
|---|---|
| Rewrite the kernel in Python | Destroys the strongest asset to chase a keyword. The Python *client* (P1-4) satisfies the screen at 2% of the cost |
| Add fine-tuning work | 15.8% demand, and the market screens ML-research and AI-engineering on different vocabularies. Splitting the profile weakens both |
| Build the adversarial test suite now | Genuinely valuable, but it's new feature work while 59 qualified applications sit unsent |
| More features | The repo is already ahead of its evidence. Every P0/P1 above converts existing work into visible proof |

---

## The sequence, as one list

1. Build `verifyCvClaims()` and re-verify the 22 existing CVs — **blocking**
2. Apply to the 13 AI-track NL roles, then the 40 backend
3. Fix the eval harness and re-run once
4. Ship the Python MCP client + eval package
5. Rewrite the README top fold
6. Add `k8s/` manifests, honestly labelled
7. Schedule the golden set weekly in CI

Items 1, 3 and 5 are days of work. Item 2 is the one that actually produces interviews.
