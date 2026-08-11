# Apply Loop — Google Sheet delivery + Mac apply queue

**Date:** 2026-08-06
**Status:** Approved by founder (chat, 2026-08-06)
**Base:** builds on `integration/jobhunt-supply-and-speed` (PR #420 — Phase 0 fixes + free ATS lane)

## Outcome this serves

The pipeline now finds and screens roles faster than the LinkedIn crowd sees them.
What it does not yet do is turn a screened role into a submitted application with
less than ~10 minutes of founder effort each. This design closes that gap: the
founder opens the Mac, the queue is already synced, and each application is one
review + one click. Applying itself stays a human act (ADR-009) — the machine
fills forms and keeps the ledger; only the founder's click submits.

## Decisions (founder Q&A, 2026-08-06)

| Question | Decision |
|---|---|
| Current Telegram messages | **Replace everything.** Brief text and new-pass ping formats go. ⚠ failure alerts stay byte-for-byte. |
| Excel delivery | **One live Google Sheet**, stable link, updated by the VPS every sweep. Service-account credential, one-time setup. |
| Heartbeat cadence | **New rows → instant message** with sheet link. Quiet sweeps roll up into a **3-hourly alive-ping**. Never 48 identical pings/day — that trains the founder to ignore the channel. |
| Apply-queue population | **Pass + stretch, ranked** — the same rows `/draft` points at, in brief-rank order. Never rejects. |
| Injected button | **One click: submit + record + next.** Clicks the site's real submit after founder review. Separate **SKIP** advances without applying. |
| Mac-open trigger | **LaunchAgent on login/wake: auto-sync + Telegram ping.** Browser queue starts only when the founder runs one command — no surprise browser takeover. |
| Architecture | **A: Postgres-first.** Sheet and Mac queue both derive from the VPS Postgres. The Sheet is a *view*, never a source of truth. |

## Part 1 — VPS side (branch `feat/jobhunt-sheet-heartbeat`)

### 1a. `applied_at` on the applications table

Nullable timestamp, drizzle migration — plus a sibling `skipped_at`, because a
skipped job must never read as an applied one; they are different facts and each
gets its own column. The apply queue is exactly:
`verdict IN (pass, stretch-flag) AND applied_at IS NULL AND skipped_at IS NULL`,
ordered by pinned rank.

### 1b. `sheet-export.ts` — the Sheet writer

Runs at the end of every sweep (both the daily paid sweep and the 30-min free
sweep). Upserts one spreadsheet via a Google service account
(`GOOGLE_SHEETS_CREDENTIALS_PATH`, `JOBHUNT_SHEET_ID` env vars — required when
the export is enabled, validated at startup).

- **Tab "Queue"** — unapplied pass + stretch rows, ranked:
  `# | Company | Title | Track | Verdict | Salary evidence | Years asked |
  Sponsor | Posted age | Liveness | Source | URL | Applied`
- **Tab "Log"** — every screened row including rejects, with gate evidence.
  The audit trail; nothing vanishes unexplained (standing rule).

The `#` column is written from the same rank-pinning that `/draft N` resolves
against (`persistBriefRanks`). Sheet row 3 and `/draft 3` are always the same
job. Rank persistence moves from "when the brief renders" to "when the export
runs" so the numbers exist even though the brief text no longer does.

A Sheets API failure sends a ⚠ alert. It never fails silent and never fails the
sweep itself — screening results are recorded before export runs.

### 1c. Messaging rework in `sweep-runner.ts`

- **Instant:** any sweep with ≥1 new pass/stretch row sends one message:
  count, top row (company — title), sheet link.
- **Alive-ping:** a 3-hourly cron line: "alive — N sweeps since last ping,
  M boards polled, 0 new" + sheet link. Proof of life without spam.
- **Removed:** the chunked daily-brief Telegram text and the old new-pass alert
  format. The `buildDailyBrief` machinery stays (it feeds ranks and the Log
  tab); only the *send* is removed.
- **Unchanged:** every ⚠ failure alert.

## Part 2 — Mac side (branch `feat/mac-apply-client`, `mac-client/` in repo)

Python 3, pinned deps, its own venv. Ported from
`~/Documents/antigravity/jolly-babbage/mac_client/` and made real.

- **`sync.py`** — one SSH invocation:
  `ssh founderos-vps psql ... --json` for the queue query → local `queue.json`.
  No SQLite file, no scp'd databases.
- **`notify.py`** — Telegram `sendMessage` only ("12 jobs ready — run `apply`").
  No polling loop, therefore no conflict with the production bot token.
- **LaunchAgent** (`com.founderos.apply-sync.plist`) + `install.sh` — fires
  sync + notify on login and on wake. The piece jolly-babbage never wired.
- **`apply_queue.py`** — Playwright + stealth Chrome, one job at a time:
  - Fills from **`apply-profile.json`** (gitignored; founder fills once:
    name, email, phone, and a track → resume-PDF path map). The tool never
    invents personal data; a missing profile field is left blank on the form.
  - **Fill adapters** for Greenhouse, Lever, Ashby standard forms. Custom
    questions are left blank for the founder — the review step exists exactly
    for these. The overlay badge states what was auto-filled vs left for review.
  - **Overlay:** `SUBMIT & NEXT` clicks the site's real submit button, records
    the application, advances. `SKIP` records a skip (`skipped_at`, keeping the
    job out of future queues without ever counting it as applied) and advances.
    Both are founder clicks — nothing submits automatically.
  - **Preflight:** refuses to start if any queued track's resume PDF is missing,
    naming the path. A dummy-file upload is the failure mode this kills.
- **Applied flow-back:** every click appends to a local crash-safe ledger
  (`applied.jsonl`); at session end (and on next sync as a catch-up), IDs are
  pushed to Postgres over SSH (`UPDATE ... SET applied_at = now()`). The next
  sweep's Sheet shows them as Applied. If the push fails, the local ledger keeps
  them and the next sync retries — the founder is told, not silently deferred.

## Error handling (loop-wide)

| Failure | Behaviour |
|---|---|
| Sheets API down | ⚠ Telegram alert; sweep results still in Postgres |
| SSH sync fails | Ping says "sync failed: <reason>" — never a silent empty queue |
| Resume PDF missing | Queue refuses to start, names the path |
| Form fill fails | Field left blank, overlay badge says so; founder completes it |
| Applied push fails | Local ledger retains; retried on next sync; founder told |

## Testing ($0, per cost-control rules)

- Fill adapters: Playwright against local `file://` HTML fixtures of real ATS
  forms — no live ATS traffic in tests.
- Sheet writer: unit tests with a mocked Sheets client.
- Queue/ledger/sync logic: pytest, mocked subprocess/SSH.
- Zero LLM calls anywhere in this loop. Live externals at runtime only:
  Google Sheets API (free tier), Telegram, and the ATS pages during a real
  apply session.

## Explicitly out of scope

- **Resume generation.** The profile points at real PDFs the founder maintains.
  A tailored-resume flow is its own future brainstorm.
- **Auto-answering custom questions.** Blank fields are honest; guessed answers
  on a legal/work-permit question are not.
- **Any merge to `main`.** Both this and PR #419/#420 merge only when the
  founder declares everything verified (instruction, 2026-08-06).

## As built (2026-08-06)

Four deviations from the design above, each with its reason:

1. **`applied_at` already existed.** It has been on `job_applications` since the
   jobhunt schema was created and already drives the re-apply staleness rule in
   `screen.ts`. Only `skipped_at` was added. The separation argument is
   unchanged and is now also why a skip must not be stamped into `applied_at`.
2. **No `@googleapis/sheets` dependency.** `google-auth-library` is already a
   dependency and the two REST endpoints are reached directly — a package in
   the lockfile, CI and audit surface for two fetch calls was not worth it.
3. **Export failures do not send their own message.** The design implied a ⚠ of
   its own; that would mean two notifications per sweep, every sweep, until the
   spreadsheet exists. The notice is folded into the message the sweep was
   already sending.
4. **Drive API is disabled on `founderos-prod`, Sheets API is enabled.**
   Verified 2026-08-06: `spreadsheets.get` on a fake id returns 404 (auth fine),
   `drive/v3/about` returns 403 "has not been used in project 463877027794".
   So the service account cannot create or share a spreadsheet. The founder
   creates it and shares it with
   `google-sheet-manager@founderos-prod.iam.gserviceaccount.com` — which is the
   better arrangement anyway: he owns the file, and it survives key rotation.

### Live evidence, this session ($0)

| Check | Result |
|---|---|
| Free lane, 15-board sample of the pruned registry | 1,482 postings in 4.9s, **0 board failures** (was 3 of 12 pre-prune) |
| Publication dates parsed | 1,466 / 1,482 (98.9%); the 16 undated are counted and reported |
| Freshness filter, cold start | 0 kept, with the reason printed — correct: every posting predates the 6h window |
| Sheets auth + request shape | 404 "Requested entity was not found" against a fake id — authenticated, correctly formed, sheet simply absent |
| Sheet row rendering | `unverifiable` → "couldn't check", `uncertain` → "unclear — verify before applying", pinned rank preserved |

**NOT VERIFIED:** no sweep has run in production against this code, no Sheet has
been written, and no application has been submitted through the Mac client. The
first real sweep after deploy is the proof.

## Verification before ship

1. `pnpm gate` green on the VPS-side branch; pytest green on the Mac branch.
2. One live end-to-end: sweep → Sheet updated → wake ping → sync → apply session
   against ONE real posting, founder at the keyboard.
3. Confirm applied row disappears from the Queue tab on the following sweep.
