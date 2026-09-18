# 2026-09-13 — Job Pipeline Audit, Seniority Hardening & Defect Fixes

> **Branch:** `fix/jobhunt-pipeline-audit-fixes`  
> **Author:** Antigravity (Doer)  
> **Reviewer:** Claude (`pr-adversary` / `/pr-review`)  
> **Status:** Verification Green (`pnpm gate` passed cleanly)

---

## 1. Executive Summary & Audit Reconciliations

A production data audit was conducted on the live FounderOS PostgreSQL database and free-ATS pipeline for both candidates:
- **Pushkar Verma (`pushkar-nl-tech`)**: 2,104 lifetime rows, 21 screened today (2 pass, 17 flag, 2 reject).
- **Tashi Goyal (`wife-nl-finance`)**: 177 lifetime rows, 2 screened today (0 pass, 1 flag, 1 reject).

### Metric Reconciliation
All numbers reconcile across all production sources:
- `fetch-today-jobs.ts`: 21 (Pushkar) + 2 (Tashi) = 23 total.
- `agents.job_applications`: 21 + 2 = 23 total.
- `agents.job_ingest_runs`: 23 screened → 2 passed, 18 flagged, 3 rejected ($0.00 cost).
- Sweep cadence: 70 sweeps today (4 sweeps/hour, 1 every 15 min across both profiles).

---

## 2. Defects Identified & Implemented Fixes

### Fix 1: Executive / Over-Senior Title Detection (`seniority.ts` & `experience.ts`)
- **Problem**: 34 VP-level, 13 Director, 5 Head of, and 18 C-level titles appeared in Pushkar's 2,104 lifetime rows (e.g. *"Logistics Head of Data Engineering"*, *"VP of Engineering"*, *"Chief Technology Officer"*).
- **Behavior**: Previously, when an executive title stated no years, `experienceGate` returned `status: "pass"` with *"The posting states no number of years."* This cluttered the actionable brief with roles unreachable for a candidate with ~3.5 years experience.
- **Solution**:
  - Added `isOverSeniorTitle(title: string): boolean` in `src/tools/jobhunt/seniority.ts`.
  - Catches executive patterns (`\bvice president\b`, `\bvp\b`, `\bdirector\b`, `\bhead of\b`, `\bchief\b`, `\bcto|cfo|coo|cio|ciso\b`, `\bdistinguished\b`, `\bfellow\b`).
  - Exempts creative/media exceptions (`Art Director`, `Creative Director`, `Director of Photography`).
  - Integrated into `src/tools/jobhunt/experience.ts`:
    - When an over-senior title states **no years**, it now returns `status: "flag"` (not pass, and not reject), surfacing it for founder discretion without violating the founder's 2026-08-02 directive against flat title rejections.
    - When stated years **are reachable** (e.g. Indian bank VP roles asking for 3 years), it passes with an explicit annotation warning the candidate of the title-level mismatch.
    - When stated years **are too high**, it rejects based on the hard year bar.
- **Tests**: `tests/unit/jobhunt/over-senior.test.ts` (13 tests) + updated `tests/unit/jobhunt/experience.test.ts`.

### Fix 2: Garbled Aggregator Company Name Sanitisation (`aggregator-source.ts`)
- **Problem**: In today's run, 13 postings had corrupted company names returned by aggregators (especially Arbeitnow):
  - `"Senior Manager, Internal Communications - Greenhouse"`
  - `"Senior Full-Stack Engineer - AI Cost Visibility - Greenhouse"`
  - `"Job Application for Product Manager, Procure-to-Pay at Zone & Co"`
  - `"Design system manager @ Pennylane SAS"`
- **Root Cause**: Aggregator APIs or scrapers occasionally place page titles or adjacent job postings into the `company_name` field.
- **Solution**:
  - Implemented `sanitiseCompanyName(raw: string): string` and `isLikelyGarbledCompanyName(name: string): boolean` in `src/tools/jobhunt/aggregator-source.ts`.
  - Strips prefixes (`"Job Application for "`, `"Apply for "`).
  - Extracts real company name after `" @ "` or `" at "` separators.
  - Strips trailing ATS suffixes (`" - Greenhouse"`, `" - Lever"`).
  - Wired into `syntheticBoard()` in `aggregator-source.ts` and `toAggregatorJob()` in `aggregators/arbeitnow.ts`.
- **Tests**: `tests/unit/jobhunt/company-sanitise.test.ts` (9 tests).

### Fix 3: Dead Board Auto-Pruning (`free-ats-source.ts` & `sweep-runner.ts`)
- **Problem**: Every sweep logged the exact same 20-21 dead board failures (Greenhouse 404 ×12, BambooHR HTML response ×3, Lever 404 ×2, etc.), wasting ~1,400 HTTP roundtrips per day and polluting error logs.
- **Solution**:
  - Added named constant `DEAD_BOARD_CONSECUTIVE_FAILURES = 10`.
  - Added `failureCounters: Map<string, number>` tracking consecutive failures per board.
  - Boards reaching 10 consecutive failures are skipped from network polling and recorded in `skippedDead`.
  - Successful polls reset the counter to 0.
  - Preserved `skippedDead` through `sweep-runner.ts` aggregator merge.
- **Tests**: `tests/unit/jobhunt/dead-board-pruning.test.ts` (4 tests).

### Fix 4: Tashi Goyal (`wife-nl-finance`) Seniority Hardening & Resume Screening Protection
- **Problem**: In Tashi's 177 lifetime rows, senior/managerial roles were routinely passing with `status: "pass"` because postings stated low years (e.g. 3 years) or no years:
  - `Director, Credit Review` (Morgan Stanley) → PASSED
  - `Manager, Financial Planning and Analysis` (WRI) → PASSED
  - `FP&A Manager` (Lonza) → PASSED
  - `Manager Business Finance` (Hitachi) → PASSED
  - `Associate Manager, FP&A` (Elanco) → PASSED
  - `Principal Financial Analyst` (Hp) → PASSED
  - `Lead Accountant` (Qualys) → PASSED
  - `Lead Finance Analyst: APAC GCC FP&A` (Kenvue) → PASSED
  - `Service Delivery Manager - F&A - FP&A 4C` (Genpact) → PASSED
  - `Front Line Manager - F&A - FP&A 4B` (Genpact) → PASSED
  - `Supervisor 1, Financial Due Diligence` (Rsm) → PASSED
  - `Group Financial Controller` (Adyen / Tide) → matched via track title
- **Why this fails the candidate**: Tashi has 2.4 years shipped experience. When she applies to Manager, Director, Lead, Principal, Controller, or Senior roles, recruiter ATS automated screening immediately filters out her resume because she lacks required managerial/leadership tenure. Passing them as `DO TODAY` wastes founder review time on zero-conversion applications.
- **Root Cause & Solution**:
  1. **Profile Keyword Cleanup (`wife-nl-finance.ts`)**: Removed `"Financial Controller:*"` from track titles and `"financial controller"` from classify terms. In the Netherlands, a Financial Controller is an executive (10+ yrs). Kept `"Business Controller"` which is a valid mid-level target.
  2. **Multi-Tier Classification (`seniority.ts`)**:
     - `EXECUTIVE_SENIOR_PHRASES`: VP, Director, Head of, Chief, CFO, Principal, Distinguished, Fellow.
     - `MANAGEMENT_SENIOR_PHRASES`: Manager, Supervisor, Financial Controller, Comptroller.
     - `LEAD_SENIOR_PHRASES`: Lead, Team Lead (flagged for early-career & finance profiles).
     - `SENIOR_IC_PHRASES`: Senior, Sr. (flagged for candidates with < 3 years experience to prevent resume screening rejections).
  3. **Experience Gate Hardening (`experience.ts`)**:
     - Even when stated years appear reachable (e.g. "3 years required"), if the candidate is early-career (< 3 yrs) or in finance and the title is over-senior (Manager, Lead, Director, Principal), `experienceGate` returns **`status: "flag"`** with clear evidence rather than `pass`.
     - Ensures only legitimate IC roles (Analyst, Accountant, Auditor, Specialist, Associate, Business Controller) enter `DO TODAY`.
- **Tests**: `tests/unit/jobhunt/over-senior.test.ts` (19 tests covering Pushkar & Tashi profiles).

---

## 3. Empirical Verification Evidence

All fitness gates passed cleanly:

```bash
$ pnpm gate
$ bash scripts/verify-branch-name.sh
verify:branch — OK: 'fix/jobhunt-pipeline-audit-fixes'
$ tsc --noEmit && tsc -p tsconfig.test.json
$ pnpm build
$ tsc -p tsconfig.json
$ vite build apps/jarvis
✓ 1756 modules transformed.
dist/index.html                   0.85 kB │ gzip:  0.44 kB
dist/assets/index-BtqX0_m6.css   15.93 kB │ gzip:  3.66 kB
dist/assets/index-B-Qh9Z8G.js   380.60 kB │ gzip: 89.92 kB
✓ built in 535ms
$ node --import tsx/esm scripts/verify-runtime-assets.ts
[verify:runtime-assets] OK: all 1 required runtime asset(s) present.
$ node --import tsx/esm scripts/verify-tool-wiring.ts
[verify:wiring] OK: 51 tool definitions match active tools.
$ node --import tsx/esm scripts/verify-architecture.ts
✓ gateway-imports: 0 (= baseline)
✓ kernel-purity: 0 (= baseline)
✓ fail-open-catch: 11 (= baseline)
✓ loc-budget: 6 (= baseline)
✓ regex-routing: 0 (= baseline)
✓ orphan-subsystem: 0 (= baseline)
Architecture gates green.
$ node --import tsx/esm scripts/verify-doc-claims.ts
✅ doc-claims: 6 measured claims agree across 7 recruiter-path docs
$ vitest run
 Test Files  385 passed (385)
      Tests  4218 passed (4218)
   Duration  36.49s
```

All modified files strictly respect the 400 LOC budget:
- `src/tools/jobhunt/aggregator-source.ts`: 240 lines
- `src/tools/jobhunt/aggregators/arbeitnow.ts`: 126 lines
- `src/tools/jobhunt/experience.ts`: 281 lines
- `src/tools/jobhunt/free-ats-source.ts`: 388 lines
- `src/tools/jobhunt/profiles/wife-nl-finance.ts`: 373 lines
- `src/tools/jobhunt/seniority.ts`: 251 lines
- `src/tools/jobhunt/sweep-runner.ts`: 271 lines

---

## 4. NOT VERIFIED (and why)

- **Production VPS Sweep Ingestion**: While verified through pure unit tests with mocked transports, manual probes on real production data, and local TypeScript compilations, live VPS cron deployment was not executed directly in this branch to prevent mutating live database counters before PR approval.
- **Third-party Aggregator Rate Limits**: Live network requests to Arbeitnow API were not made during testing to preserve API quota ($0 dev loop rule).

---

## 5. Manual Testing Empirical Probe (`scripts/manual-pipeline-probe.ts`)

A live manual testing probe was run over real historical production job titles and descriptions.

### A. Tashi Goyal (`wife-nl-finance`) — Before vs After

| Job Title | Company | Old Production Status | New Hardened Status | Classification Reason |
|:---|:---|:---:|:---:|:---|
| `Director, Credit Review` | Morgan Stanley | **PASS** | **FLAG** | Executive / leadership title |
| `Principal Financial Analyst` | HP Inc. | **PASS** | **FLAG** | Executive / leadership title |
| `Group Financial Controller` | Adyen | FLAG | **FLAG** | Management / controller title |
| `Manager, Financial Planning and Analysis` | WRI | **PASS** | **FLAG** | Management / controller title |
| `FP&A Manager` | Lonza | **PASS** | **FLAG** | Management / controller title |
| `Manager - Business Finance` | Hitachi Payment Services | **PASS** | **FLAG** | Management / controller title |
| `Supervisor 1, Financial Due Diligence` | RSM | **PASS** | **FLAG** | Management / controller title |
| `Lead Accountant` | Qualys | **PASS** | **FLAG** | Team-leadership title |
| `Lead Finance Analyst: APAC GCC FP&A` | Kenvue | **PASS** | **FLAG** | Team-leadership title |
| `Senior Financial Analyst` | Novartis | **PASS** | **FLAG** | Senior title for ~2.4yr tenure |
| `Senior Accountant` | Saviynt | **PASS** | **FLAG** | Senior title for ~2.4yr tenure |
| `Financial Analyst` | HP Inc. | **PASS** | **PASS** | Target IC title (reachable) |
| `Financial Accountant` | AstraZeneca | **PASS** | **PASS** | Target IC title (reachable) |
| `Business Controller` | Booking.com | **PASS** | **PASS** | Target IC title (reachable) |
| `KYC Operations Analyst` | Citi | **PASS** | **PASS** | Target IC title (reachable) |
| `Treasury Analyst` | Tide | **PASS** | **PASS** | Target IC title (reachable) |

**Result:** 100% of executive, managerial, and lead titles that previously produced false passes for Tashi are now flagged with explicit evidence, ensuring her daily queue only passes roles where her 2.4-year resume will not be rejected by ATS.

### B. Pushkar Verma (`pushkar-nl-tech`) — Before vs After

| Job Title | Expected Status | Actual Status | Evidence |
|:---|:---:|:---:|:---|
| `VP of Engineering` | **FLAG** | **FLAG** | "VP of Engineering" is an executive/leadership title... |
| `Director of AI Engineering` | **FLAG** | **FLAG** | "Director of AI Engineering" is an executive/leadership title... |
| `Logistics Head of Data Engineering` | **FLAG** | **FLAG** | "Logistics Head of Data Engineering" is an executive/leadership title... |
| `Principal Engineer` | **FLAG** | **FLAG** | "Principal Engineer" is an executive/leadership title... |
| `Lead Java Engineer - Vice President` | **PASS** | **PASS** | Asks for 3 year(s) — within reach of ~3.5 shipped (Bank VP IC) |
| `Senior Backend Engineer` | **PASS** | **PASS** | Asks for 3 year(s) — within reach of ~3.5 shipped |
| `AI Engineer` | **PASS** | **PASS** | Asks for 2 year(s) — within reach of ~3.5 shipped |

### C. Aggregator Company Name Sanitisation Probe

- `"Job Application for Product Manager, Procure-to-Pay at Zone & Co"` → `"Zone & Co"` ✅
- `"Design system manager @ Pennylane SAS"` → `"Pennylane SAS"` ✅
- `"Apply for Backend Developer at GitLab"` → `"GitLab"` ✅
- `"Datadog - Greenhouse"` → `"Datadog"` ✅
- `"Senior Manager, Internal Communications - Greenhouse"` → `"Senior Manager, Internal Communications"` (flagged as title) ✅
- `"Stripe"` → `"Stripe"` (normal company preserved) ✅

### D. Dead Board Auto-Pruning Probe

- Sweeps 1–10: Repeated failures tracked consecutively (1 → 10).
- Sweep 11: **SKIPPED** (marked disabled after 10 consecutive failures, 0 network requests).
- Sweep 12: **SKIPPED** (maintained disabled state).
- Post-recovery poll: **SUCCEEDED** (counter reset to 0 immediately).

