# Telegram One-Click Auto-Apply & Candidate Reference Dossier (2026-10-16)

## Goal
Enable one-click job applications from Telegram on the standalone `founderos` VPS service (`src/jobs/main.ts`), backed by a per-candidate Reference Dossier (`candidate-dossier.md`) and learned question bank (`question_bank` in `apply-profile.json`), with interactive Telegram Q&A when a form asks an unknown question and `ADR-018`-compliant human-confirmed submission.

## Checked First
- `scripts/verify-architecture.ts`: `apply-headless.ts`, `apply-driver.ts`, `apply-scrape.ts`, `apply-fill.ts`, and `apply-commands.ts` were tombstoned on 2026-08-25 (`e7f1288d`, `fff7340e`) when the Mac client was chosen. New modules use clean names (`candidate-dossier.ts`, `form-brain.ts`, `form-scraper.ts`, `form-runner.ts`, `auto-apply.ts`) and respect all R1–R7 fitness gates.
- `src/jobs/main.ts` and `src/jobs/bot.ts`: standalone jobs process (since 2026-10-10) has no kernel; commands and `jh:` callbacks run directly in `src/jobs/bot.ts`.
- `mac-client/mac_client/adapters.py` and `f75f6a96`: live-verified selectors and hydration/reveal rules for Greenhouse, Lever, Ashby, Workable, and Recruitee already exist in git history.
- `founderos-vps`: Playwright Chromium `149.0.7827.55` is installed and launches cleanly under `founderos`.

## Architecture (Multi-Candidate by Construction)
1. **`src/tools/jobhunt/candidate-dossier.ts`**:
   - Per-profile `candidateDossierPathFor(profileId)` (`/opt/founderos-data/candidate-dossier.md` for default, `candidate-dossier-<profileId>.md` for others).
   - Pure parser (`parseDossierMarkdown`), question key normalizer (`normalizeQuestionKey`), and deterministic answer resolver (`lookupLearnedAnswer`) that checks `profile.question_bank`, dossier Q&As, and structured dossier/profile facts.
   - `recordLearnedAnswer` saves new answers to both `apply-profile-<profileId>.json` (`question_bank`) and `candidate-dossier-<profileId>.md`.
2. **`src/tools/jobhunt/form-brain.ts`**:
   - Pure form planner (`buildFormFillPlan` and `summariseFormPlan`).
   - Enforces hard safety stops: CAPTCHAs are never touched; eligibility/visa questions use closed-set `chooseEligibility` or explicit profile-confirmed answers; unknown questions emit `ask`.
3. **`src/tools/jobhunt/form-scraper.ts`**:
   - Normalises live DOM fields across Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters, Personio, Teamtailor, BambooHR, and generic HTML forms into `ScrapedField[]`.
4. **`src/tools/jobhunt/form-runner.ts`**:
   - Headless Playwright form filler (`prepareApplicationForm`) and `ADR-018`-compliant submitter (`submitApplicationForm`) with pre-flight `checkValidity()`, post-click error/confirmation verification, and full-page proof screenshots.
5. **`src/gateway/auto-apply.ts` + `src/jobs/bot.ts`**:
   - `/apply <n>` and `/wife_apply <n>` commands, plus `🚀 Auto-Apply` (`jh:f:<rowId>`) on drafted packets.
   - Interactive Telegram Q&A: inline option buttons (`jh:q:<rowId>:<idx>`) and free-text reply capture in `bot.ts` that writes answers back to the candidate's dossier and re-fills the form.
   - `🚀 Submit Application` (`jh:s:<rowId>`) and `⏭ Skip` (`jh:k:<rowId>`) buttons with post-submit screenshot proof.
   - Telegram document upload support in `bot.ts` (`/profile` caption on `.md`/`.txt` updates the candidate dossier; `.pdf` updates the candidate's default resume).
