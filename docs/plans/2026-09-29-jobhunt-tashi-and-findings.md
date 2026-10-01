# Jobhunt: get Tashi from 0 applications to a weekly habit, and turn jobhunt defects into fixes automatically

| | |
|---|---|
| **Branch** | `claude/feat-jobhunt-tashi-and-findings` (base `main` @ `1e797039`) |
| **Executor** | Claude cloud session. No VPS or prod DB access, so every prod number you need is below. Cloud sessions usually do have public internet, so the ATS spike (task B3) can run there. |
| **Depth** | **Full**: task C re-enables a cron that files GitHub issues on the founder's behalf. Parts A and B alone would be Lite. |
| **One of four** | `claude/fix-dispatch-loop-hardening` · `claude/fix-chat-context-truth` · `claude/feat-goals-daily-standup` · `claude/feat-jobhunt-tashi-and-findings`. **Merge last**: part C files work into the loop the dispatch branch hardens. **No migration in this branch**, because the goals branch owns `0042`. |

## The founder moment
- **Tashi:** she opens a role from her brief and the Mac client pre-fills the employer's actual form, not the posting page. This includes SmartRecruiters (Deloitte NL, BDO) and Dutch-labelled fields. She reviews and clicks Submit. The goals-branch standup counts it the next morning.
- **Founder:** a jobhunt defect (for example "ashby adapter returns 0 jobs from every board since Tuesday") becomes **one** GitHub issue with evidence rows, capped at 1 per day. He gets one Telegram line about it. Dead boards stop being polled on their own, with no issue and no message.

## Measured facts (2026-09-29, prod `agents.*`)
- **Supply is not the binding constraint. Applying is.** `wife-nl-finance` over the last 30 days:
  - 446 rows: NL 101, India 298, unknown 40. India is intended: the founder confirmed her right to work there on 2026-09-08, per `profiles/wife-nl-finance.ts:35`.
  - Actionable NL rows: **28 `do_today` + 14 `stretch` + 20 `ask` = 62**.
  - **`applied_at` set on 0 rows ever. `tailor_status='done'` on 0. `skipped_at` on 0.**

  Nothing marks a row as seen, applied or rejected. Either she isn't seeing them, or she's applying outside the system and nobody records it. **This is a founder question, not something to infer.** Her new rows per week: 65, 114, 79, 85, 103.
- **The 09-28 audit's ranked plan** (`docs/audits/2026-09-28-jobhunt-supply-to-apply-audit.md`, merged in #751): S1 (vocabulary, NL 21→56 per 30 days) and the apply-link recognisers shipped. **Not done:**
  - A1, a SmartRecruiters field map for the Mac client: 30 of her 64 NL rows. `grep -ci smartrecruiters mac-client/mac_client/adapters.py` = **0**.
  - A2, open the form URL instead of the posting.
  - A3, Workday: 12 rows. `grep -ci workday` = **0**.
  - A4, Dutch field labels in `resolver.py`.
  - S6, precision: bare `auditor` and `due diligence`, plus working-student titles.
- **A5 is done.** `/opt/founderos-data/apply-profile-wife-nl-finance.json` exists on the VPS.
- **S2 is mostly done.** `docs/strategy/data/nl-finance-employers.csv` already lists EY, KPMG, Forvis Mazars, Flynth, ABN AMRO, Van Lanschot, Moore, Deloitte, BDO and Rabobank. Still missing: ASN Bank, Essent, Kraft Heinz, Royal FloraHolland, ING. Belastingdienst is government; leave it out.
- **Dead boards are polled forever.** In 7 days there were 670 `free-boards` sweep runs, and **every sampled run's `error` says "30–33 board(s) failed: greenhouse HTTP 404 ×16–18; ashby HTTP 404 ×3–4; lever HTTP 404 ×3…"**. That's the same dead boards on every 30-minute sweep.
- **The unmerged branch `fix/jobhunt-pipeline-audit-fixes`** (2 commits, 2026-09-13, no PR, 128 behind `main`) has a dead-board skip. It counts failures **in process memory** (`defaultFailureCounters = new Map()`), so a restart resets it, and a skipped board is never probed again. **Don't merge that branch.** Reuse its idea and its test (`tests/unit/jobhunt/dead-board-pruning.test.ts`, 110 lines), with persisted state.
- **The findings→issue machinery already exists and is switched off.**
  - `src/evolution/` has analyzers (`code-health`, `dead-code`, `telemetry`), fingerprint dedupe against its own `evolution:auto` history (`dispatch-findings.ts`), an issue body in the agent-task template shape (`issue-body.ts`), and "decision, not implementation" kinds that never go to Antigravity.
  - Its cron was removed on 2026-08-21 (`src/infra/scheduler.ts:15–23`). It last filed #539 on 2026-08-21, and all four issues it ever filed were `unused-dependency`.
- The data root is `FOUNDEROS_DATA_ROOT`, default `/opt/founderos-data` (`src/tools/jobhunt/apply-profile.ts:105`). It survives deploys.

## Binding constraint
62 actionable NL roles in 30 days and 0 applications. More supply does nothing until the last mile works and is recorded.

**Strongest argument against doing supply at all in this branch:** agreed, so supply is capped at two $0 items (B1, B2) plus one measured spike (B3). Paid supply (S4, Indeed) waits for founder approval.

## Scope

### A. Last mile (do first)
1. **A1 · SmartRecruiters field map** in `mac-client/mac_client/adapters.py`, with a fixture test in `mac-client/tests/test_adapters.py` following the existing Ashby pattern. Save a real SmartRecruiters apply page as the fixture if you can reach one, or ask; don't invent the DOM.
2. **A2 · Open the form, not the posting.** Port the per-adapter `applyUrlFor()` rules (`src/tools/jobhunt/adapters/*.ts`, called from `apply-packet.ts:65`) into `adapters.py`, as Ashby already does. Pin one test per platform.
3. **A4 · Dutch labels** in `resolver.py`: voornaam, achternaam, e-mailadres, telefoonnummer, cv, motivatiebrief, plus variants. Table-driven test.
4. **Apply is recorded, zero LLM.** The Mac client ledger (`test_ledger.py` exists) already records what it opened. Make sure a submitted application reaches `job_applications.applied_at` through the existing `/wife_applied` path. If the ledger never posts back, add a single `founderos applied <id>` call at the end of the Mac client flow. **Grep first** (`mac-client/mac_client/*.py` and `src/gateway/jobhunt-commands.ts`); if this already exists, write down where and skip it.
5. **S6 · Precision:** qualify bare `auditor` and `due diligence` for her profile, and drop `working student` and `stage` titles. Pin each of the 4 titles in the audit's "Precision noise" list as a rejected case in `tests/unit/jobhunt/tashi-track-recall.test.ts`.

### B. Supply ($0 only)
1. **B1 · Persisted dead-board skip.** Store `{ "<ats>:<token>": { streak, first_failed_at, last_probe_at } }` in `${FOUNDEROS_DATA_ROOT}/board-health.json`, written atomically (write `.tmp`, then rename).
   - Skip a board after `DEAD_BOARD_STREAK = 10` consecutive **404s**. Only a 404 counts: a 429 or 5xx is not "dead".
   - **Re-probe skipped boards once every 7 days**, so a revived board comes back.
   - The sweep summary says "skipped N dead boards", instead of 30 failures on every run.
   - Reuse the unmerged branch's test cases.
2. **B2 · Registry join for the 5 missing employers.** Add them to `docs/strategy/data/nl-finance-employers.csv` and run `pnpm jobhunt:import-boards --employers --dry-run`. Commit only the rows the strict join finds, and paste the dry-run output in the PR.
3. **B3 · SuccessFactors spike, 1 hour, time-boxed, no production code.** Memory recorded that 85 of 126 NL finance employers sit on SuccessFactors (measured 2026-09-08). Measure whether 3 real NL SuccessFactors career sites expose a public, unauthenticated job list (an XML feed or a JSON search endpoint) that a deterministic adapter could poll. Write the result, with the URLs and payload samples, to `docs/audits/2026-09-29-successfactors-feed-spike.md`. **Don't build the adapter in this branch.** If the spike says yes, that becomes the next brief.

### C. Jobhunt findings → fixes (deterministic, $0)
1. **New analyzer** `src/evolution/analyzers/jobhunt.ts`: a pure function over rows from `job_ingest_runs` and `job_lane_heartbeats`. New `FindingKind`s:
   - `adapter-silent`: a platform whose boards all return HTTP 200 but whose total `returned` fell to 0 for 24h after a non-zero 7-day baseline. **Implementation** kind: a parser broke.
   - `apply-link-unrecognised`: the share of new rows on one platform with no form link exceeds 30% over 7 days. **Implementation** kind.
   - `lane-silent`: `zero_pass_streak ≥ 6` for a profile. **Decision** kind: Telegram only, never an issue.
   - `candidate-not-acting`: actionable rows ≥ 20 and 0 applied in 14 days. **Decision** kind: Telegram only.

   Put thresholds in named constants, with a comment naming the prod number that justified each one (the numbers above). Dead boards are **not** a finding, because B1 heals them in code.
2. **Re-enable the dispatch sweep for jobhunt kinds only.** Add a daily 09:30 cron (`{ timezone: appTimeZone() }`) that runs just this analyzer through the existing `runSelfImprovementDispatch`, filing at most **1 issue per day**, fingerprint-deduped, labelled `agent:ready` + `evolution:auto`.
   - It must **make zero LLM calls**. Prove that with a test that injects a throwing model.
   - Leave the code-health analyzers disabled; they're a separate decision.
   - **Read** `dispatch-findings.ts` and `issue-body.ts` before wiring. Their header comments mention `resolveExecutorCwd` as the old failure. Confirm, with a test on a fake `IssueGateway`, that today's path only files an issue and never touches it.
3. **Telegram line**, always sent (see `dispatch-sweep.ts`'s "IT ALWAYS SENDS"): "Jobhunt check: filed #N <title>", or "nothing new", or "check failed: <reason>".

## Out of scope
- LinkedIn discovery (S3), which needs founder OK on terms-of-service risk.
- Indeed for Tashi (S4), a paid cron that needs founder OK.
- Dutch-titled roles (S5), which need her Dutch level. **Founder answer, don't guess.**
- Workday (A3), because every tenant needs a human-created account. Do it after A1/A2 prove the pattern.
- Anything that clicks Submit. **Submit stays human**: memory records `submit_application` clicking Submit before HITL approval on 2026-08-24.

## Edge cases the tests must cover
| Case | Required behaviour |
|---|---|
| `board-health.json` missing or corrupt | Start empty, warn once. Never skip everything, never crash the sweep |
| Two sweeps overlap and both write the file | Atomic rename, and the last writer wins. A lost increment is acceptable, a torn file is not. Test it |
| A board returns 404, then 200 | Its streak resets to 0 on the 200 |
| A 429 storm from one platform | Not counted as dead. Rate limiting is a different failure |
| The analyzer's DB read fails | The sweep says "check failed: <reason>" in Telegram. It files nothing and doesn't claim "nothing new" |
| The same finding persists for 10 days | One issue total (fingerprint history is read with `state: "all"`) |
| The founder closes the auto-issue as won't-fix | Still suppressed. A closed issue counts as filed (existing behaviour, keep its test) |
| Dispatch loop paused (quota, auth) | The issue still files. The dispatch branch's pause message covers the rest |
| Dutch label collides with an English one ("cv") | The resolver maps both to the same field. There's no double-fill |

## Verification
- `pnpm gate` (TS side): N/N, 0 skipped, counts shown. `cd mac-client && python -m pytest`: N/N, counts shown.
- **Real-path assertions (after merge, VPS):**
  1. After 5 hours of sweeps (10 at `*/30`), `jq 'length' /opt/founderos-data/board-health.json` shows about 30 entries, and the `job_ingest_runs.error` of the latest run says "skipped N dead boards".
  2. The next 09:30 Telegram line arrives, and says either "nothing new" or names the filed issue.
- **Tashi path:** open one SmartRecruiters row with the Mac client on her laptop and confirm the pre-fill. Only the founder or Tashi can do this. **NOT VERIFIED until they do.**

## Founder questions (answer in chat; the branch can start before them)
1. Does Tashi see her brief (`/wife_today`)? Has she applied anywhere since 09-01, inside or outside FounderOS?
2. Her Dutch level (S5): none, basic, or professional?
3. May the Indeed lane run for her, NL only, every 3 days, at about $0.06 per 1,000 jobs (S4)?
