# 2026-09-16 — Tashi profile-scope backfill + model config fix

## What we did

- Fixed `listRecentApplications` (`src/db/job-queries.ts`) to scope by `profileId` via the
  existing `profileCondition()` helper, matching every sibling query function in the file. It was
  the one function in the file that had no profile scoping at all — its sole caller,
  `scripts/jobhunt-backfill-gates.ts`, read up to 1000 rows spanning both candidates and
  re-screened every one of them under `DEFAULT_PROFILE_ID` (`pushkar-nl-tech`) regardless of whose
  row it was.
- Gave the backfill script a `--profile=<id>` flag (`resolveProfileArg`), resolved the same way
  `screen_job` already resolves a profile id, plus the entry-point guard
  (`import.meta.url === file://${process.argv[1]}`) every sibling backfill/audit script already
  has — this one was the exception, which is what made it unsafe to import in a test at all.
- Wrote RED tests first for both (`tests/unit/db/list-recent-applications-profile-scope.test.ts`,
  `tests/unit/scripts/jobhunt-backfill-gates-profile.test.ts`), confirmed RED, implemented, confirmed GREEN.
- Live-probed Gemini model candidates against the real API (VPS prod key) before picking any slug:
  `gemini-2.5-flash` is fully retired (404, Google's own error names `gemini-3.6-flash` as the
  replacement); `gemini-3.5-flash` (what the `gemini-flash-latest` rolling alias currently resolves
  to) returned 503 "high demand" 2/2 live attempts; `gemini-3.6-flash` returned 200 2/2. Pinned
  `AGENT_MODEL=google-genai:gemini-3.6-flash` in `scripts/apply-prod-env-overrides.sh`.
- Added `JUDGE_MODEL=google-genai:gemini-3.1-flash-lite` (live-probed 200) since the previous
  default (`openrouter:nvidia/nemotron-3-super-120b-a12b:free`) crashes on every call (`undefined`
  `.message` read). `getJudgeModel()` already had a working `google-genai` branch — config-only.
- Live-tested OmniRouter locally (laptop, port 20128) — works, ~12s for a reasoning-tier combo
  model — but intentionally not wired into prod; its own code comment already explains why
  (hardcoded `127.0.0.1`, nothing listens there on the VPS).
- Updated `tests/unit/scripts/apply-prod-env-overrides.test.ts` (it hard-pinned the old
  `AGENT_MODEL` string) and added a `JUDGE_MODEL` assertion.
- Shipped both fixes as [PR #688](https://github.com/pushkarverma3698/FounderOS/pull/688) →
  `beta` (CI green, merged), promoted via [PR #690](https://github.com/pushkarverma3698/FounderOS/pull/690)
  `beta` → `main` (CI green, merged at `4ade36b3`), watched the real deploy (confirmed via
  `ActiveEnterTimestamp`, not `git rev-parse` alone).
- Ran the actual backfill against prod, scoped to `wife-nl-finance`, via `/opt/review/founderos`
  (never `/opt/founderos`).
- Verified the deployed model config live: a real Telegram probe (18s, clean reply) and a direct
  `judgeOutbound()` call (real "revise" verdict with a substantive critique — not reachable via
  the fail-open path, which only ever returns "pass").
- Traced GitHub issue #687 (a founder-dispatched Antigravity task): it claimed, ran 28 of its
  1800s budget, and failed with zero commits and no PR ("print timeout... with turn in progress").
  Two of its six named anomalies were already fixed earlier the same day by PRs #683/#684, merged
  before #687 was even claimed.

## What we fixed

- Tashi's stale screening rows: 71 of 230 verdicts changed on the live backfill, including the
  exact role named in PR #679's motivating comment (`WRI — "Manager, Financial Planning and
  Analysis"`, `pass → reject`). 103 rows now carry a real `"gate":"Level"` entry in `gate_json`
  (0 before — none of her rows predated the level gate).
- A production model pinned to a rolling alias that has already caused one incident
  (2026-07-13: persistent 503s, 14/15 turns died) and was live-probed today reproducing the same
  failure mode.
- A judge model that crashed on every invocation, silently failing the outbound-message review
  gate open on every call (fail-open logs an `error`, but nothing surfaces it to the founder
  per-turn).

## Why

Founder asked, in one session: (1) backfill Tashi's stale senior-role rows now that her title
ceiling is set, (2) test and fix the Gemini model choice properly rather than guess, test
OmniRouter, and swap the judge model to a working Gemini slug "for now", (3) check whether GitHub
issue #687 actually got dispatched. All three are now resolved with live evidence rather than
assumption — the live-probing step specifically overturned two assumptions that looked reasonable
on paper (`gemini-2.5-flash` as a "safe established" candidate; `gemini-3.5-flash`, what the alias
already resolves to, as the "no-op safe pin") and would have been wrong if shipped without testing.

## Metrics

- 230 rows re-screened for `wife-nl-finance`; 71 verdict changes (30.9%); 0 errors; 0 skipped as
  already-engaged.
- 103/230 rows now carry a `"gate":"Level"` entry (0/230 before).
- `pnpm gate`: 4440/4440 tests passing (7 new/modified in this work), one pre-existing unrelated
  doc-claims warning (README.md:303 test-count drift — flagged separately, not fixed here).
- Live model probes: `gemini-2.5-flash` 404 (dead), `gemini-3.5-flash` 0/2 success (503 both
  times), `gemini-3.6-flash` 2/2 success direct + 1/1 success through the real Telegram path
  (with one transient 503 that self-recovered via the existing retry backoff — not a clean zero-503
  run, worth knowing). `gemini-3.1-flash-lite` (judge) 1/1 success direct + 1/1 through
  `judgeOutbound()`.

## Outstanding

- The re-bucketing of Tashi's rows into `brief_section`/`brief_rank` (the do-today/stretch display
  buckets) was NOT touched by this backfill — `screenPosting`'s upsert only updates `gate_json` /
  `salary_status` / etc., not the brief-section label. The corrected verdicts will surface in her
  brief on the next scheduled brief-generation cycle, not immediately. Nothing further needed
  unless the founder wants it forced sooner.
- Google's Gemini backend showed elevated 503 rates across multiple models during this session's
  testing window (evening 2026-09-16 UTC) — not specific to `gemini-3.6-flash`. Worth a quick
  sanity check if 503 rates still look high in a day or two.
- Stale doc-claims drift (`README.md:303`) flagged as a separate background task
  (`task_b6005108`), not fixed in this session — out of scope for what was asked.
- GitHub issue #687 is open and unclaimed; may get auto-re-claimed by the next `agent-dispatch`
  cron tick. No action needed — Antigravity will discover on its own that 2 of its 6 anomalies are
  already fixed.
