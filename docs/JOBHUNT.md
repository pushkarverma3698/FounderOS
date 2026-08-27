# The jobhunt pipeline — end to end

Last verified: 2026-08-25 (live QA against production — see `docs/plans/2026-08-24-jobhunt-supply-to-apply-pipeline-audit.md`
and `docs/plans/2026-08-25-jobhunt-apply-completion-brief.md` for how this state was reached).

**What it does:** finds job postings, screens them against lawful-sponsorship and salary gates,
ranks the survivors into a daily brief, tailors a CV on command, and puts the application in front
of the founder — on his own Mac, one job at a time — for him to click Submit himself.

**What it is not:** a machine that submits applications unattended. That lane existed and was
retired 2026-08-25 (see [Architecture invariants](#architecture-invariants) below). Every
application that goes out today is a founder click.

---

## The pipeline, in order

```
DISCOVERY          board registry (1,297 boards) + metered feed
     │              → src/tools/jobhunt/free-boards.ts, sweep-runner.ts
     ▼
SCREENING          sponsor gate, salary gate, route, track, liveness
     │              → src/tools/jobhunt/screen.ts, gates.ts, sponsor-match.ts
     ▼
RANKING / BRIEF    do_today (cap 6) + stretch (cap 4), 24h freshness window
     │              → src/tools/jobhunt/brief-select.ts, daily-brief.ts
     ▼
TAILORING          on command only — /draft N on Telegram
     │              → src/tools/jobhunt/tailor-cv.ts, apply-packet.ts
     ▼
MAC QUEUE SYNC     pull ranked rows + CVs from the VPS over SSH
     │              → mac-client/mac_client/wake.py, sync.py
     ▼
APPLY              one job on screen, founder reviews, founder clicks
     │              → mac-client/mac_client/apply.py, overlay.js, adapters.py
     ▼
OUTCOME TRACKING   ledger → Postgres, stage lifecycle, follow-up nudges
                    → mac-client/mac_client/ledger.py, pipeline-followup.ts
```

---

## 1. Discovery (supply)

Two feeds, both write into `agents.job_applications` after screening:

| Feed | Cadence | Cost | Coverage |
|---|---|---|---|
| Free board lane | every 30 min (`FREE_SWEEP_CRON = */30 * * * *`) | $0 — public unauthenticated JSON endpoints | Greenhouse, Lever, Ashby, Workable, Recruitee boards in the registry (1,297 boards as of 2026-08-20, see `docs/plans/2026-08-20-jobhunt-sponsor-board-import.md`) |
| Metered feed (Apify) | every 3rd day (`JOB_SWEEP_CRON = 30 1 */3 * *`) | ~$0.46/run | Reaches boards outside the registry; returns description text Greenhouse withholds from the free feed |

Full detail on the free lane's economics and measured lag: [`docs/JOBHUNT-FREE-LANE.md`](./JOBHUNT-FREE-LANE.md).
That doc's numbers predate the registry's growth to 1,297 boards — treat the lag figures as
directional, not current.

## 2. Screening

Every posting from either feed passes the same gates (`src/tools/jobhunt/gates.ts`,
`screen.ts`), recorded as one `job_applications` row via `recordScreenedApplication`
(`src/db/job-queries.ts`):

- **Sponsor verdict** (`sponsor_verdict`) — matched against the IND recognised-sponsor register
  (`sponsor-match.ts`, `sponsor-registry.ts`). `sponsor | not-sponsor | uncertain`.
- **Salary gate** (`salary_status` + `salary_evidence`) — `pass | flag | reject` against the
  under-30 HSM floor (see `docs/strategy/09-NL-ENTRY-CAMPAIGN.md`).
- **Route** (`route`) — `hsm | remote-contract`, which set of gates applied.
- **Track** (`track`) — `ai | backend | frontend | fullstack | unclassified`, from the title,
  deterministically (`track-vocabulary.ts`). Drives which base CV gets tailored.
- **Country** (`country` + `location`) — from the feed, never re-derived from the ad's prose. A
  posting whose location can't be read stays `unknown`, not silently `india-local`.
- **Liveness** (`liveness`) — `unknown | live | expired | unverifiable`. A failed check is
  `unverifiable`, never conflated with `expired`.
- **`gate_json`** — every gate's own status + evidence, not just the flattened `salary_evidence`
  string. This is what the brief actually prints per-row so a role flagged on salary doesn't
  display its passing sponsor line as the headline reason.

Re-screening a posting the machine has already seen **updates** the row (`onConflictDoUpdate` on
`(tenant_id, dedupe_key)`) rather than inserting a duplicate — `stage` survives the update so an
already-applied role is never reset to `screened`.

## 3. Ranking — the daily brief

`src/tools/jobhunt/brief-select.ts` + `daily-brief.ts` turn the pool of passing/flagged rows into
two capped, ranked lists:

| Section | Cap | Constant |
|---|---|---|
| `do_today` | 6 | `DO_TODAY_CAP` |
| `stretch` | 4 | `STRETCH_CAP` |

**Freshness window: 24 hours** (`APPLY_QUEUE_MAX_AGE_HOURS`, env-tunable). A posting older than a
day doesn't show — see the long comment on that constant in `src/db/job-queries.ts` for the
2026-08-24 history of why (briefly raised to 168h, reverted same day: the free lane's only edge is
reaching a posting while it's still hours old).

`brief_section` and `brief_rank` are **pinned at render time** so `/draft 2` keeps resolving to the
row the founder was looking at, even if the next sweep reshuffles the order. `/applied N` clears
the pin (`clearBriefRank`) so a stale row number can't silently re-target a second application.

## 4. Tailoring — on command only

**There is no automatic bulk tailoring.** This was deliberate, not an oversight — see
[Known limitation: CV fabrication](#known-limitation-cv-fabrication-risk) below for why a cron
version was built, tested, and then removed before merge.

CVs are tailored exactly two ways, both founder-triggered:

- **`/draft N`** on Telegram (`src/gateway/jobhunt-commands.ts:handleDraft`) — tailors row N (or
  `/draft all` for the current brief), one call to `tailorCv()` per row.
- Re-running `/draft` on an already-tailored row re-tailors it (no dedupe on the tailoring side).

`tailorCv()` (`src/tools/jobhunt/tailor-cv.ts`):
1. Loads the base CV for the row's `track` (`readFullCvText`, `src/tools/career.ts`) —
   `PERSONAL_CV_DIR/{track}/`, four tracks: ai, backend, frontend, fullstack.
2. Computes an overlap score between the JD's extracted skill terms and the base CV
   (`overlapScore`, `skills.ts`) — logged as `asked` / `matched` / `ratio`.
3. Calls the model via `invokeWorkerWithFallbacks` (**not** `getWorkerModel().invoke` directly —
   that would bypass the fallback chain and the cost ledger).
4. Runs `findSlop()` — a banned AI-tell word list — and requests one revision if it fires.
5. Renders to PDF (`cv-renderer.ts`, Playwright), uploads to S3
   (`ready-applications/{date}/{company-slug}/…`), writes `tailored_cv_s3_key` +
   `tailor_status = 'tailored'` back onto the row.

### Known limitation: CV fabrication risk

**Confirmed 2026-08-25, live QA against 4 real queue rows and the founder's real base CV:**
`tailorCv()` will state skills the base CV does not contain. Measured:

| Job | JD skills absent from base CV | Appeared in tailored output anyway |
|---|---|---|
| Altura (backend) | 6 | 4 — C#, .NET, Kubernetes, Domain-Driven Design |
| Visa (ai) | 26 | 17 — Python, Java, LangChain, FastAPI, Spring Boot, gRPC, Kubernetes, Prometheus, Pinecone… |
| Capgemini (fullstack) | 13 | 4 — Python, JavaScript, Java, vector database |
| Gartner (ai) | 12 | 11 — PyTorch, TensorFlow, scikit-learn, pandas, NumPy, NLP, Databricks… |

The founder's actual base CV is TypeScript/Node — it contains no Python, Java, PyTorch, TensorFlow,
or Kubernetes. `findSlop()` is a banned-word list; it has no mechanism to catch an invented claim
that isn't on that list.

**Mitigation today:** none, mechanically. The founder reads the tailored CV before submitting. The
overlay's green "tailored CV attached" label means *a tailoring pipeline ran*, not *verified true*.

**Fix proposed, not built:** an entity/date cross-check — extract capitalised entity spans and
date tokens from the tailored output, assert each appears in the base CV, fail the packet naming
the offending span (`docs/plans/2026-08-25-jobhunt-apply-completion-brief.md`, T6). Until this
exists, do not re-add bulk/automatic tailoring (see below).

### Why there is no auto-tailor cron

A cron calling `processUntailoredApplications()` (`src/tools/jobhunt/tailor-worker.ts`) every 30
minutes over the untailored backlog was built and CI-tested 2026-08-25, then **removed before
merge** on founder review, for two independent reasons:

1. **Product**: tailoring is meant to be a deliberate act triggered by `/draft`. A queue row
   without a tailored CV should say so honestly — which the Mac client overlay's three-state label
   already does — not have one silently manufactured for it in the background.
2. **Safety**: see the fabrication finding above. Running that unguarded on a 30-minute cadence
   against a 600-row backlog would have spent a finite, non-renewable resource (the IND sponsor
   pool) on fabricated resumes.

The function and its tests are kept (`/draft` calls the same underlying `tailorCv()`, deliberately,
one row at a time) — only the `cron.schedule()` registration in `src/infra/scheduler.ts` is gone.
**Do not re-add it without the fabrication guard in front of it.**

## 5. Mac queue sync

`python -m mac_client.wake` (`mac-client/mac_client/wake.py`) — runs on login/wake via a
LaunchAgent, never opens a browser:

1. `sync_profile()` — pulls `apply-profile.json` from the VPS over SSH so the Mac never fills a
   form from a three-week-stale local copy.
2. `fetch_queue()` + `save_queue()` (`sync.py`) — pulls the ranked `do_today`/`stretch` rows and,
   for each, fetches its CV from S3 into `.queue/{job_id}/`:
   - If `tailored_cv_s3_key` is set, fetches that PDF.
   - Otherwise (or on fetch failure), the row falls back to the track's generic resume.
3. A failed S3 fetch is **collected and reported**, not swallowed — in both the terminal and the
   Telegram wake message (`notify.queue_ready_message`), naming the company and the reason. This
   was T1a's fix: the original `save_queue` caught the fetch exception and wrote nothing, silently.
4. One Telegram message announcing the queue count and the first few roles by name.

**`$STORAGE_BUCKET` note:** the S3 fetch command reads this from the VPS app's own env file
(`/opt/founderos/.env`) rather than relying on shell expansion over non-interactive SSH — a bare
`ssh host 'echo $STORAGE_BUCKET'` returns empty on this box because the non-interactive shell
doesn't load the profile that sets it. Confirmed empty via that exact bare form, 2026-08-25;
`sync.py` does not make that mistake.

## 6. Apply — the founder's click

`python -m mac_client.apply` (`mac-client/mac_client/apply.py`, 339 lines):

- Opens the browser on **one job at a time**, autofilled where the ATS is recognised.
- Shows, before every submit: company, title, description, salary/location, and **which CV is
  attached** — the three-state label:

  | State | Meaning |
  |---|---|
  | 🟢 green — "Tailored CV for this role attached" | a tailored PDF exists on disk for this row |
  | 🟡 amber — "Generic CV — no tailored one exists for this role yet" | never `/draft`ed; uploading the track's generic resume |
  | 🔴 red — "the tailored one FAILED to download" | `tailored_cv_s3_key` was set but the S3 fetch failed |

  This is a **three-state signal, not two** — a fix made 2026-08-25 after QA found the first
  version only warned on the red case (4 of 62 real queue rows) and stayed silent on the amber
  case (the other 58), which is the same silent-substitution failure in a different shape. See
  `mac-client/mac_client/profile.py:uses_tailored_cv` / `tailored_cv_missing`.

- **SUBMIT & NEXT** — presses the site's own submit button, records `applied` to the local ledger,
  advances. **SKIP** — records `skipped`, advances. Both are the founder's click; the machine never
  submits unattended (ADR-018).
- Cover letters and work-authorisation/demographic questions are **deliberately left blank** —
  `adapters.py` states why, and a test (`test_the_cover_letter_and_work_authorisation_are_left_alone`)
  holds that boundary. The founder fills those himself, from the same screen.
- At session end: `push_outcomes()` flows the local ledger to Postgres (idempotent — an `IS NULL`
  guard means re-running never double-counts), and one Telegram message reports the session tally
  (`notify.session_summary_message` — applied/skipped/errored) to the founder's main channel, not
  just the terminal he ran it from.

### ATS adapter coverage — what actually autofills

`mac-client/mac_client/adapters.py` has field maps for five ATS platforms:

| ATS | Autofills | Added |
|---|---|---|
| Greenhouse | ✅ | original |
| Lever | ✅ | original |
| Ashby | ✅ | original |
| Workable | ✅ | T4, 2026-08-25 — ported from the VPS lane's `apply-fill.ts` selectors |
| Recruitee | ✅ | T4, 2026-08-25 — same |

**Everything else is a blank form** — the browser opens on the posting, the resume field is filled
via `resolver.py`'s heuristic DOM search if it can find one, and the founder fills the rest by
hand. Measured against the live queue 2026-08-25: **13 of 62 rows** (21%) matched a known ATS;
the other 49 (mostly Workday, SmartRecruiters) are manual. This is the real ceiling on
apply *volume* per session, independent of the CV question.

Recruitee coverage matters disproportionately: it was added because the IND sponsor register match
rate for NL-native ATS platforms (2.50%) is roughly 7x the US-centric platforms (0.36%) — see
`docs/plans/2026-08-20-jobhunt-sponsor-board-import.md`.

## 7. Telegram commands

| Command | Handler | Does |
|---|---|---|
| `/draft N` (or `all`) | `jobhunt-commands.ts:handleDraft` | Tailor CV for brief row N (or every current row) |
| `/applied N` | `jobhunt-commands.ts:handleApplied` | Mark row N applied, clear its brief pin |
| `/replied N` | `live-application-commands.ts:handleReplied` | Mark a live application as having heard back |
| `/rejected N` | `live-application-commands.ts:handleRejected` | Mark a live application rejected |
| `/profile` | `profile-commands.ts:handleProfile` | View/edit the apply profile the Mac client reads |
| `/jobs` | `jobhunt-view.ts:handleJobs` | List the current brief |
| `/csv` | `jobhunt-view.ts:handleCsv` | Export the current pipeline as CSV |
| `/ask` | `jobhunt-commands.ts:handleAsk` | Free-text question against a brief row |

All new `/applied` / `/replied` / `/rejected` commands echo the company name back
(`"Marked replied — Ockto (Senior Backend)"`) rather than just acknowledging a number — `brief_rank`
gets re-pinned up to 48x/day by the sweep, so a bare "OK" against a possibly-stale row number would
be silent about which row it actually hit.

## 8. Outcome tracking — the funnel's back half

Stage lifecycle (`stage` column): `screened → drafted → awaiting_approval → applied → replied |
rejected | dormant`.

- **`listLiveApplications()`** (`src/db/job-queries.ts`) — every row still worth watching
  (`LIVE_STAGES = drafted, awaiting_approval, applied, replied`). Called by the Monday pipeline
  digest (`pipeline-followup.ts:runPipelineDigest`, cron `0 9 * * 1`).
- **Follow-up sweep** (`runFollowupSweep`, daily `0 9 * * *`) — rows in `applied` with no
  `last_contact_at` movement at day 7 and day 14 get a one-tap follow-up draft, incrementing
  `followups_sent`.
- **The funnel query** — answers "how many applications, how many replies, over what window" in
  one read:

  ```sql
  SELECT stage, count(*) FROM agents.job_applications
  WHERE tenant_id = 'turicks' GROUP BY stage ORDER BY 2 DESC;
  ```

## 9. Cost tracking

Every tailoring call routes through `invokeWorkerWithFallbacks` (`src/agents/worker-invoke.ts`),
which writes one row to `ai_call_costs` per call via `BudgetGuardCallback` + `costSink`, checked
against `BUDGET_DAILY_USD` (daily cap, default $5).

**Fixed 2026-08-25:** the model-id passed into `BudgetGuardCallback` used `??`, which does not
catch an empty string — and production sets `WORKER_AGENT_MODEL=` (empty, not unset). Every cost
row from a worker call was being attributed under an empty model id rather than the model that
actually answered. Changed to `||`. Same defect class as the `jq //` bug noted elsewhere in this
project's history — neither operator treats `""` as absent.

---

## Architecture invariants

**There is now exactly one apply lane.** The VPS lane (`/apply N` → machine clicks after an HITL
card) was retired 2026-08-25, founder decision. Tombstoned in `scripts/verify-architecture.ts` —
CI fails hard if any of these return:

```
src/agents/agent-tools/jobhunt-apply.ts
src/gateway/apply-commands.ts
src/tools/jobhunt/apply-headless.ts
src/tools/jobhunt/apply-driver.ts
src/tools/jobhunt/apply-scrape.ts
src/tools/jobhunt/apply-fill.ts
```

The selectors those files drove for Workable/Recruitee were ported into
`mac-client/mac_client/adapters.py` (T4) before the VPS-side files were deleted — nothing was lost,
only relocated to the lane that's actually used.

## File map

**Kernel / VPS side** (screening, ranking, tailoring, Telegram commands):
```
src/tools/jobhunt/screen.ts, gates.ts, sponsor-match.ts   — screening gates
src/tools/jobhunt/brief-select.ts, daily-brief.ts         — ranking + brief
src/tools/jobhunt/tailor-cv.ts, tailor-worker.ts          — CV tailoring (per-row; batch fn unused by design)
src/tools/jobhunt/free-boards.ts, sweep-runner.ts         — discovery
src/tools/jobhunt/pipeline-followup.ts                    — digest + follow-up sweep
src/gateway/jobhunt-commands.ts                            — /draft, /applied, /ask
src/gateway/live-application-commands.ts                   — /replied, /rejected
src/gateway/jobhunt-view.ts                                 — /jobs, /csv
src/db/job-queries.ts                                       — job_applications queries
src/db/schema.ts (jobApplications table, ~line 959)          — the schema itself
```

**Mac client** (`mac-client/`, see also `mac-client/README.md`):
```
mac_client/wake.py       — login/wake trigger: sync + notify, no browser
mac_client/sync.py       — pull queue + CVs from the VPS over SSH
mac_client/apply.py      — the browser queue + overlay loop
mac_client/profile.py    — apply-profile.json + the tailored/generic CV signal
mac_client/adapters.py   — per-ATS field maps (Greenhouse, Lever, Ashby, Workable, Recruitee)
mac_client/resolver.py   — heuristic DOM fallback for unrecognised ATS forms
mac_client/ledger.py     — crash-safe local JSONL, flushed per click
mac_client/notify.py     — one-shot Telegram POST (not a second bot)
mac_client/overlay.js    — the on-page review UI (resume label, SUBMIT/SKIP)
```

## Related docs

- [`docs/JOBHUNT-FREE-LANE.md`](./JOBHUNT-FREE-LANE.md) — free board lane economics (numbers dated 2026-08-06)
- [`docs/plans/2026-08-20-jobhunt-sponsor-board-import.md`](./plans/2026-08-20-jobhunt-sponsor-board-import.md) — registry growth to 1,297 boards
- [`docs/plans/2026-08-24-jobhunt-supply-to-apply-pipeline-audit.md`](./plans/2026-08-24-jobhunt-supply-to-apply-pipeline-audit.md) — the audit this doc's architecture derives from
- [`docs/plans/2026-08-25-jobhunt-apply-completion-brief.md`](./plans/2026-08-25-jobhunt-apply-completion-brief.md) — T1–T6 execution brief (T1–T4 shipped; T5–T6 open, see below)
- [`docs/strategy/09-NL-ENTRY-CAMPAIGN.md`](./strategy/09-NL-ENTRY-CAMPAIGN.md) — the salary floor and permit constraints the gates enforce

## Open work (not built)

- **T5 — cover letter to Telegram.** Currently generated, slop-checked, archived to S3, and left
  alone on the form. Not yet pushed to Telegram for copy-paste while the founder is on the apply
  screen.
- **T6 — fabrication guard.** See [Known limitation](#known-limitation-cv-fabrication-risk) above.
  This is the prerequisite for ever re-enabling bulk/automatic tailoring, not merely a nice-to-have.
- **Base CV audit.** The `ai`-track base CV at `PERSONAL_CV_DIR` has been flagged unaudited by
  three consecutive review passes. Whether it should claim Python/Java is a founder decision, not
  an engineering one — worth resolving since it changes how the fabrication numbers above should
  be read.
