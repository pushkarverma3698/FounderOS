# 2026-09-08 — closing the seven defects from the 5-day production QA audit

## What we did

Took a production QA audit covering `founderos.service` from 2026-09-02 22:12 to
2026-09-07 22:10 UTC and fixed all seven findings, each starting from a reproduced
failure rather than a log line. Branch `claude/fix-prod-qa-audit-batch`.

Three defects the audit did not name were found while verifying the ones it did.
Two of them would have made the audit's own recommended fix actively harmful.

## What we fixed

**1. `export_jobs_csv` — job CSVs were model prose (CRITICAL, #2 in the audit)**
There was no CSV export tool at all. The jobhunt prompt's step 4 instructed the
worker to call `job_state`, compose the CSV text itself, and pass that string to
`write_artifact` — so every company, title and apply link in every export was
retyped by a model from JSON it had read earlier. The artifact receipt could not
catch it: `write_artifact` verifies that a file exists and how many bytes it is,
never that the bytes are the rows.

New `src/tools/jobhunt/jobs-csv.ts` queries Postgres and serialises through the
existing pure `sheet-rows.ts` + `csv-export.ts`. The model chooses the FILTER and
never authors a CELL. The receipt carries `rows:N,with_url:M` so a "URLs included"
claim can be contradicted by the envelope.

**2. The run budget could never stop a run (CRITICAL, #1)**
`BudgetGuardCallback` threw `BudgetExceededError` from `handleLLMEnd`, a LangChain
`BaseCallbackHandler` method. LangChain catches whatever a handler throws and logs
it, so the dedicated `catch (err instanceof BudgetExceededError)` in
`kernel-run.ts` was structurally unreachable. Enforcement now rides the AbortSignal
the turn timeout already uses (`enforceRunBudget`), wired into all three kernel
invoke paths. `budget.breachError()` re-types the resulting generic AbortError so
the founder sees the cap, not a crash.

**3. `job_state`'s `section` filter answered 0 rows in silence (#4)**
`section` was passed raw to an `eq()`. Its own description advertised display
headings ("DO TODAY", "ONE QUESTION AWAY") that no row has ever carried, and
`job_brief` prints `track` — a different column. Both spellings returned
`success: true` with 0 rows, which reads as "the market has none of these".
Sections are now validated and aliased, `track` is its own filter, and an
unrecognised value is refused with the argument that does work.

**4. Funding grower crashed nightly, silently, for five days (#6)**
One Workday token derived from a funding headline threw out of the mapper, out of
`Promise.all`, and killed the entire night's batch. The scheduler spawned it with
`stdio: "ignore"`, so production recorded only `{"code":1}` — four identical
nights, no cause. Now: only name-derivable platforms are probed, a throwing token
is a logged skip, hosts settle independently, and stderr is captured.

**5. The judge model was dead again, invisibly (#5)**
`minimax/minimax-m2.7:free` is absent from OpenRouter's catalogue; its own error
says the free tier was withdrawn. Third dead slug in three weeks. The slug is
replaced with one verified live, but the real fix is that failing open now leaves
a mark: `judge-health.ts` counts consecutive failures and an hourly cron tells the
founder once per outage episode.

**6. The agent could not read its own source in production (#3)**
`projectRoot()` is `$HOME/Projects`; production runs from `/opt/founderos`. This
is why the 2026-09-06 "why is `/jobs` giving stale jobs?" investigation ended with
"the root cause could not be determined" — the agent was asked to diagnose itself
with its own source outside its sandbox. The running app's root is now a second
allowed root, derived from the process and never from a tool argument.
(GitHub issue #426 item 5, open since 2026-08-08.)

**7. Expired Google credentials never reached the founder (#7)**
`invalid_grant` twice in the window, `log.warn` only. Credential failures are now
separated from transients, logged at `error`, and sent to Telegram with the
re-authorisation only the founder can perform. (Issue #426 item 4.)

### Found while verifying — not in the audit

- **The `job_state` LangChain wrapper had no `profile` field.** The tool gained a
  profile filter on 2026-09-07 and its description tells the worker to pass one
  whenever a candidate is named. The wrapper the worker actually calls never
  exposed it, so the instruction was impossible to obey and every named-candidate
  question silently ran against the default queue. `track` was dropped the same way.
- **`fullDetails` was declared in `JobStateArgs` and never read** — the select was
  unconditionally the curated 10 columns, so `job_state({fullDetails:true})`
  answered "all 40 DB columns" with the same 10 and said nothing.
- **SmartRecruiters and BambooHR return HTTP 200 for tenants that do not exist**
  (`{"totalFound":0}` and a 43 KB marketing page respectively). The probe checked
  only `res.ok`, so every candidate was a "hit". Fixing the crash alone would have
  switched on a channel writing a dozen junk boards a night into the registry the
  30-minute poll reads — worse than the dead channel it replaced.

## Why

Five of the seven share one failure shape: **a failure that renders identically to
a success.** A swallowed callback throw, a filter miss that returns an empty
result set, a fail-open judge, a `{"code":1}` with no stderr, a `log.warn` nobody
greps. In each case the code was doing something reasonable and the *absence of a
distinguishable signal* was the defect. That is why several fixes add a loud
channel rather than change a behaviour — and why `judge-health` and the provider
alert are wired to a cron, not to a comment asking someone to check (rule #27).

The second theme is that **the requested fix was not always the whole fix.**
Repairing the funding grower's crash without the 200-is-not-a-board guard would
have made the system worse in a way that emits no signal, which is the exact
failure class the audit was written about.

## Metrics

| | before | after |
|---|---|---|
| `tashi_goyal_screened_jobs.csv` usable apply links | **0 / 50** (all "N/A") | — |
| `job_applications_export.csv` deep links | **2 / 25** (23 bare domains) | — |
| `export_jobs_csv` against the same prod DB, 91 rows | — | **91 / 91 verbatim**, 0 N/A, 0 truncated |
| Funding sweep exit code | 1 (5 nights running) | **0** |
| Funding news signals per sweep | 2 (2 of 4 sources dead) | **12** |
| Junk boards the repaired sweep would write | 12 | **0** |
| `job_state({section:"accountant"})` | `success:true`, 0 rows | **refused, names `track`** |
| `job_state({track:"accountant"})` | unreachable | **5 rows** |
| `list_files src/gateway` on the prod box | outside sandbox | **29 entries** |
| Tool calls issued after a budget breach | ≥ 1 per breach, 5 breaches | **0** |
| Unit tests | 3862 | **3908** (357 files, gate green) |

### Verification actually performed

- **Prod database, read-only** (`/opt/review/founderos`, never `/opt/founderos`):
  exported Tashi's 91 rows and compared every URL cell against
  `agents.job_applications.url` — 0 missing, 0 `N/A`, 0 truncated. Ran the four
  `section`/`track` spellings against real data.
- **Prod box**: `projectRoots()`, `list_files src/gateway` (29 entries),
  `read_file src/gateway/jobhunt-view.ts` (6089 chars); `.env` and `/etc/passwd`
  both still correctly denied.
- **Funding sweep, before and after**: pre-fix script exits 1 with the exact
  production error (`Workday token "oxfordquantumcircuitsjust" …`); post-fix exits
  0 with 12 signals and 0 junk boards.
- **Judge slugs, live against prod's own key** ($0, free tier): the configured
  slug returns `404 This model is unavailable for free`; the replacement returns
  clean parseable JSON and the correct verdict on a deliberately slop-y draft.
- **Budget**: a graph-level test (`tests/unit/kernel/budget-abort-e2e.test.ts`)
  runs the real StateGraph with scripted models, delivers a breach mid-run through
  LangChain's own `CallbackManager`, and asserts the second tool is never invoked.

### NOT VERIFIED

- **No Telegram end-to-end run.** `TELEGRAM_TESTER_API_ID` / `_API_HASH` /
  `_SESSION` are still unset, so `scripts/lib/mtproto.ts` cannot drive the real
  transport. Per CLAUDE.md this is a fallback, not a substitute: the planner
  routing to `export_jobs_csv`, the prompt change taking effect, and the reply the
  founder actually sees are all **unproven**. The tool, the DB read, the CSV
  bytes and the receipt are proven.
- **The budget guard has not fired on a real production turn** — only on the real
  graph offline. Reproducing a live 100k-token breach costs paid Gemini calls.
- **`/jobs` staleness (#3) is not root-caused.** What shipped is the prerequisite
  the audit itself named — the agent can now read its own source in prod. The
  freshness question is still open.

## Outstanding

1. Add `TELEGRAM_TESTER_API_ID` / `_API_HASH` / `_SESSION` to `.env`
   (`node --import tsx/esm scripts/telegram-tester.ts login`) so this path can be
   driven end-to-end instead of stopping one layer in.
2. Send `give me a CSV of Tashi's screened jobs` in Telegram after deploy and open
   the file — that is the one check this session could not run itself.
3. `/jobs` freshness still has no root cause; the blocker on investigating it is
   now removed.
4. Company-name extraction from funding headlines is weak
   ("Oxford Quantum Circuits just", "Ecommerce Fulfilment Startup Zippee"), which
   is why 12 clean signals still yield 0 real boards. Separate from this batch.
5. Prod secret rotation from the 2026-08-12 `.env` process-arg exposure is still
   outstanding and unrelated to this work.
