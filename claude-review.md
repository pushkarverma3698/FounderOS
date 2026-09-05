# Claude Code Review Handoff — Job Pipeline & Migration Parity

**Branch:** `cursor/feat-unified-postgres-brain` (target for PR: `beta`)  
**Status:** **100% VERIFIED & GREEN** (`pnpm gate` passed 340 test files / 3726 tests)  
**Date:** 2026-09-05  

---

## 1. Executive Summary of Work Accomplished

In this engineering session, Antigravity executed several critical bug fixes across the jobhunt pipeline, multi-profile isolation filters, and Drizzle database migrations:

1. **Job Pipeline Digest & Followup Sweeping**:
   - Updated `listLiveApplications` and `listFollowupCandidates` in `src/db/job-queries.ts` to strictly scope queries by `profileId` using `profileCondition()`.
   - Wrapped `runFollowupSweep()` inside `src/tools/jobhunt/pipeline-followup.ts` with a `listProfiles()` loop so follow-up nudges are isolated per candidate profile instead of indiscriminately grouped.
   - Updated test mocks in `tests/unit/jobhunt/pipeline-followup.test.ts` using `mockResolvedValueOnce()` to avoid artificially bloating candidate sweep metrics during the isolated profile looping.

2. **Multi-Profile Isolation & Permit Bug Fix**:
   - Removed `zoekjaar` from the `UNCLEAR_BASES` fallback list in `src/tools/jobhunt/permit-routes.ts`. This strictly enforces the comment directive that orientation-year permits must not be applied to un-located postings, fixing the bug where remote/ambiguous jobs mistakenly assumed Dutch residency permissions.

3. **CV Path Local Dev Overrides (`wife-nl-finance.ts`)**:
   - Reverted a hardcoded test-only path check that was breaking `brief-cv-profile-isolation.test.ts`. Replaced it with a safe `process.env["WIFE_CV_PATH"]` fallback. This safely allows local dev overrides while ensuring the production default (`/opt/founderos-data/cv/...`) passes unit isolation tests without crashing.

4. **Missing Database Migration Parity**:
   - The `brain.brain_memories` table was present in `schema.ts` but lacked its `0037_brain_memories.sql` migration, causing the `schema-migration-parity.test.ts` gate to fail.
   - Restored `0037_brain_memories.sql` and manually linked it into Drizzle's `drizzle/meta/_journal.json`.
   - Verified the migration using `pnpm db:migrate` and successfully executed a `pnpm brain:sync` to populate the new unified RAG memory system.

---

## 2. Verification Ladder

Before handing off, all automated verification gates were executed successfully locally:

```bash
pnpm gate
```

- **`pnpm lint`**: Clean.
- **`pnpm build:all`**: Clean backend emit + Vite frontend compilation.
- **`pnpm verify:wiring`**: Passed.
- **`pnpm verify:arch`**: Passed.
- **`pnpm test`**: **340 test files / 3726 tests 100% green**.

---

## 3. Structured Prompt for Claude Code (Adversarial Review)

Copy and run the following prompt in your terminal with Claude Code (`claude -p`):

```bash
claude -p "You are operating as the Senior Engineering Judge and Adversarial Code Reviewer for FounderOS on branch cursor/feat-unified-postgres-brain.

Read the handoff brief at claude-review.md and docs/antigravity/CLAUDE_REVIEWER_INSTRUCTIONS.md.

YOUR MANDATE:
1. Verify the current codebase state by running 'pnpm gate'. Confirm all 340 test files / 3726 tests pass.
2. Conduct an adversarial code audit on the changes made to:
   - src/db/job-queries.ts
   - src/tools/jobhunt/pipeline-followup.ts
   - src/tools/jobhunt/permit-routes.ts
   - src/tools/jobhunt/profiles/wife-nl-finance.ts
   - drizzle/0037_brain_memories.sql & drizzle/meta/_journal.json
3. Check for false successes, unescaped strings, and base drift.
4. If any BLOCKER is found, fix it directly on the branch, run 'pnpm gate', and push your fix.
5. If no BLOCKERs exist, approve the work and process the merge to 'beta' as outlined in the instructions.
"
```
