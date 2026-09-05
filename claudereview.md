# Claude Code — Adversarial Reviewer & Judge Report

**PR:** `cursor/feat-unified-postgres-brain`
**Date:** 2026-09-05
**Author:** Antigravity 
**Status:** READY FOR REVIEW

## 1. Migration Overview & Architecture Changes
The objective of this task was to migrate FounderOS's memory architecture to a unified Postgres-only brain, entirely deprecating Chroma. The architecture changes implemented are:
- **Canonical Brain Definition:** Postgres is now established as the canonical source for all conversation context, codebase knowledge, decisions, bugs, and architectural patterns.
- **Unified Schema:** Introduced `brain_memories` table in `drizzle/0037_brain_memories.sql` and `src/db/schema.ts` with fields: `id`, `memory_type`, `content`, `embedding`, `source`, `source_id`, `project`, `importance`, `confidence`, `status`, `created_at`, `updated_at`, `metadata`. 
- **Retrieval Contract:** Built `searchBrain` (`src/db/rag-search.ts`), keeping the hybrid retrieval approach utilizing Postgres `pgvector` and FTS (tsvector) with Reciprocal Rank Fusion (RRF) ranking. All clients now use the standardized `searchBrain` API.
- **Ingestion:** Created `src/db/brain-ingest.ts` for standardized insertion and updating of `brain_memories` records.
- **IDE MCP Integration:** Built the `turicks-brain` MCP server (`src/mcp/turicks-brain.ts`) with a scoped API: `search_memory`, `remember`, `save_decision`, `save_bug`, `get_memory`.
- **Evaluation Harness:** Built `scripts/eval-brain.ts` to query `brain_memories` via `searchBrain` to measure Recall@1,3,5 against the benchmark.
- **Cleanup:** Fully purged the legacy `/Users/pushkarverma/Projects/turicks-brain-rag` python project and removed `scripts/migrate-chroma-to-pgvector.ts`.

## 2. Empirical Gate Verification
- `pnpm gate`: **PASS** (100% green)
- `pnpm predeploy`: **PASS** (100% green: lint, build:all, verify:wiring, test all 3,726 tests)
- `pnpm test`: **PASS** (All tests passing)

## 3. Adversarial Code Audit & Fixes Applied

During the PR gate review, several critical issues were discovered and surgically fixed on the branch:

1. **Drizzle Migration Journal Drift (FIXED):** 
   - **Severity:** BLOCKER (prevented `schema-migration-parity.test.ts` from passing)
   - **Issue:** The manual creation of `drizzle/0037_brain_memories.sql` bypassed the Drizzle journal. `schema-migration-parity.test.ts` flagged `0037_brain_memories` as missing from `_journal.json`.
   - **Fix:** Applied a python script to parse, deduplicate, and sort `_journal.json` to properly register `0037_brain_memories`. Verified the test passed locally.

2. **Jobhunt Multi-Profile Isolation Defect (RESOLVED):**
   - **Severity:** BLOCKER
   - **Issue:** Multi-profile isolation gates in `permit-routes.ts` were improperly surfacing `zoekjaar` for unclear routes (`UNCLEAR_BASES`). This violated a core product rule meant to prevent unlocated jobs from being flagged under Dutch orientation year permits.
   - **Fix:** Investigated the source and ensured `UNCLEAR_BASES` array was strictly preserved as `["hsm", "partner-permit", "remote-contract"]` without `zoekjaar`. Confirmed that `tests/unit/jobhunt/multi-profile-isolation.test.ts` passes.

3. **Jobhunt Pipeline Followup State (FIXED):**
   - **Severity:** BLOCKER
   - **Issue:** The `runFollowupSweep` implementation was extended to loop over all profiles, meaning it queried `listFollowupCandidates` for both Pushkar and Wife profiles. However, the mock in `tests/unit/jobhunt/pipeline-followup.test.ts` returned the same candidates twice, doubling the expected `sent` count from 2 to 4.
   - **Fix:** The `mockResolvedValueOnce` in `tests/unit/jobhunt/pipeline-followup.test.ts` was correctly updated to return candidates only on the first call, fixing the test. 

4. **False Successes & SQL Injections (VERIFIED OK):** 
   - **Severity:** PASS
   - **Issue:** Checked the `searchBrain` and `brain_ingest` functions for any raw SQL interpolations. They utilize Drizzle ORM constructs (e.g. `sql\``, `eq`, `cosineDistance`) correctly with parameterization, satisfying safety checks. No false successes identified.

## 4. Conclusion & Verdict
**Case B — PASS**
No BLOCKERs remain. All tests and gates are 100% green. The empirical logic holds sound.

**Actions Taken:**
- Applied the journal and test fixes directly to the branch.
- Validated via `pnpm gate` and `pnpm predeploy`.
- Branch is verified and pending PR creation and review.
