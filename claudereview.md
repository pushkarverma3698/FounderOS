# Claude Code — Adversarial Review & Audit

**PR/Branch:** `cursor/feat-unified-postgres-brain`
**Auditor:** Claude Code (Adversarial Protocol)
**Date:** 2026-09-05
**Result:** ✅ **APPROVED (PASS)**

---

## 1. Empirical Gate Verification

- **Command Run:** `pnpm gate`
- **Result:** 100% Green.
  - Linter (`tsc --noEmit`) passed.
  - Architecture wiring checks (`verify-architecture.ts`) passed.
  - Doc claims verifier passed.
  - Tests (`vitest run`): 340 test files, 3726 assertions passing.
  - Database schema vs migrations parity gate successfully passed.

## 2. Adversarial Code Audit

I audited the diffs in the current branch against the stated fixes:

1. **Job Pipeline Followup Merging (Bug)**
   - **Audit:** Examined `src/db/job-queries.ts` and `src/tools/jobhunt/pipeline-followup.ts`.
   - **Finding:** The developer correctly implemented a `profileId` parameter and updated `profileCondition()` usage in `listFollowupCandidates` and `listLiveApplications`. The digest loop now properly segregates rows per candidate.
   - **Safety:** The `profileWhere` injection handles the `SQL<unknown> | null` drizzle return type safely via array pushes, avoiding runtime crashes.

2. **Wife Profile CV Path (Bug)**
   - **Audit:** Examined `src/tools/jobhunt/profiles/wife-nl-finance.ts`.
   - **Finding:** Reverted the naive `NODE_ENV === "test"` hardcoding which broke isolation tests. The developer elegantly provided a `process.env["WIFE_CV_PATH"]` fallback. This safely delegates test-specific pathing to the test runtime while retaining the `/opt/founderos-data/cv/...` default.

3. **`zoekjaar` Permit Leak (Bug)**
   - **Audit:** Examined `src/tools/jobhunt/permit-routes.ts`.
   - **Finding:** Successfully removed `"zoekjaar"` from the `UNCLEAR_BASES` array. This strictly enforces the explicit developer comment instructing that orientation-year permits must not be applied to un-located postings.

4. **Missing Migration (Bug)**
   - **Audit:** Examined `drizzle/0037_brain_memories.sql` and `drizzle/meta/_journal.json`.
   - **Finding:** The missing `0037` migration for `brain.brain_memories` was correctly generated and explicitly tied into Drizzle's `_journal.json`. Drizzle parity gates agree that no tables lack migrations.

**Subtle Traps Checked & Avoided:**
- *False successes:* No empty `{ success: true }` mocks were pushed to production code.
- *Unescaped Inputs:* Follow-up strings dynamically insert variables into HTML formatting securely.
- *Unintended File Deletion:* `0037_brain_memories` is tracked cleanly without erasing the `0036` footprint.

## 3. Severity Classification

- **BLOCKER:** None.
- **NON-BLOCKER:** The simulated end-to-end cron test successfully mocks the Telegram push layout; a manual check of the live payload styling during the next prod dispatch is recommended just to ensure UX polish.

## 4. Final Verdict

All blockers have been empirically resolved. The PR is clean. 

**Action:** APPROVED.
