# Job Application Pipeline: Current State

## 1. How new jobs enter FounderOS
Jobs enter the system via job fetchers (aggregators/board scrapers like Indeed, ATS scrapers) running periodically. They populate `jobApplications` (in `src/db/schema.ts`) using deduplication keys (`dedupe_key`). The `jobIngestRuns` table records ingestion metrics. Jobs typically start with stage `screened` in `jobApplications`.

## 2. How Pushkar jobs are represented
Represented in `jobApplications` with `profile_id` set to `pushkar-nl-tech` or similar `pushkar` identifiers. Configuration for Pushkar's apply profile is in `mac-client/apply-profile-pushkar.json` and backend profiles `src/tools/jobhunt/profiles/`.

## 3. How Tashi jobs are represented
Represented in `jobApplications` with `profile_id` referencing Tashi's profile (e.g. `wife` profile, like `apply-profile-wife.example.json` in `mac-client`).

## 4. How senior jobs are represented
Seniority and tracks are assigned deterministically or via AI rules (e.g. `track` column in `jobApplications`, seniority levels resolved via `src/tools/jobhunt/seniority.ts`).

## 5. How application materials are generated
Currently managed by `tailor-cv.ts`, `tailor-tool.ts`, and `cover-letter.ts`. The process runs and sets `tailor_status` to `pending | tailoring | tailored | failed` and updates S3 keys (`tailored_cv_s3_key`, `tailored_docx_s3_key`, `cover_letter_s3_key`) in `jobApplications`.

## 6. How mac-client currently opens/fills/submits jobs
The Mac client runs locally. It queries pending applications via API or sync. It loops through a queue of jobs (`apply.py`). It uses Playwright to open the ATS URL (`page.goto`). It identifies the ATS (Greenhouse, Lever, Ashby, Workable, Recruitee) via `ats_for_url` in `adapters.py`. It uses `FieldMap` CSS selectors to locate and fill `first_name`, `last_name`, `email`, `phone`, `linkedin`, `website`, and `resume` fields. It leaves unknown or complex fields empty. It injects `overlay.js` to show the user what was filled/skipped. The user (Founder) clicks the actual submit button. The decision is recorded back to `jobApplications`.

## 7. How URLs are extracted from ATS platforms
URLs are extracted during the fetch/ingest phase and stored in `jobApplications.url`. Some platforms (Ashby, Workable) require URL modification to access the actual form (e.g. appending `/application` or `/apply`), handled in `apply.py`.

## 8. How the current browser automation works
`apply.py` uses `playwright.async_api.async_playwright()`. It launches Chromium in headed mode (`headless=False`). It uses native keyboard simulation (`page.keyboard.type` with `Meta+A`) for filling fields to mimic human interaction. It waits for basic form elements like `#first_name` before filling. If an exception occurs, it simply skips filling that field.

## 9. What can be reused
- `FieldMap` selectors for GreenHouse, Lever, Ashby, Workable, Recruitee (`mac-client/mac_client/adapters.py`).
- Ashby and Workable URL resolution logic.
- Playwright page management and `_fill_first` / `_upload_first` logic.
- The `ApplyProfile` schema and `ApplicationPacket` extraction.

## 10. What must move to VPS
- Playwright execution environment (headless or Xvfb on Linux VPS).
- The queuing logic (`apply.py` loop) must become an autonomous worker process (`job_application_operator`).
- Human interaction via `overlay.js` and manual submit click needs to be replaced by deterministic automated submission, with fallback to an AI Runtime (Antigravity) when the page deviates from expectations.
- A new persistent Application Queue state machine (`DISCOVERED` -> `QUEUED` -> `PREPARING` etc.).

## 11. Existing persistence/state/receipt mechanisms
- `jobApplications` table maintains `stage` (e.g. `applied`, `rejected`, `skipped`).
- The Mac client uses `ledger.py` and `sync.py` to push outcomes to Postgres.
- `hitl_approvals` (Human-in-the-loop) queue handles human fallback.
- `action_log` guarantees idempotency for side-effects.
