# 2026-09-07 — jobhunt profile coverage, dead judge model, and the Tashi heartbeat

## What we did

Two PRs, both merged to `main` and deployed, in response to a live production bug report
("screened jobs not appearing for Tashi, numbers differ between commands, no message from
the 30-min sweep for her lane") plus an explicit founder audit request.

**[PR #626](https://github.com/pushkarverma3698/FounderOS/pull/626)** (`53bb1e7`):
1. 10 files still referencing the retired `brain.turicks_brain` table, repointed to
   `brain.brain_memories` (ADR-038).
2. Reverted the daily brief's 7-day STANDING pool back to a strict 24h window, per founder
   choice — the "apply within 24h or it clears" mental model the founder described doesn't
   match what shipped 2026-09-01 (a widening reach fix), and he chose to revert rather than
   keep the wider pool.
3. `job_state` had NO profile filter at all — the reported bug. Root-caused to a missing
   `profileWhere` clause in `queryJobState` (src/db/job-queries.ts) and a tool that never
   exposed a `profile` argument in the first place.
4. `judgeOutbound`/`judgeAnswer`'s shared model (src/infra/judge-model.ts) was pointed at a
   fully dead OpenRouter free slug, AND — the harder-to-spot half — its replacement
   (`minimax/minimax-m2.7:free`) is a reasoning model that burns 400-600+ tokens on
   chain-of-thought it cannot disable, so the pre-existing 512-token cap silently starved
   every real call. Both confirmed via live API calls, not assumption. Fixed: correct model
   + `maxTokens: 3000`.
5. The Tashi-heartbeat silence: `sweep-runner.ts`'s alive-ping state lived in an in-process
   `Map`, wiped by every restart (18 in 3 days). Replaced with a real table
   (`agents.job_lane_heartbeats`, migration `0039`) and `job-heartbeat-queries.ts`.
6. Systemic audit of every other jobhunt tool for the same missing-profile-filter defect
   class: `screen_job`, `tailor_cv`, `review_screened`, `cv_gaps`, `job_brief` all had it too,
   at varying depths. Fixed with one shared resolver (`resolveProfileArg` in
   `agent-tools/jobhunt.ts`).

**[PR #627](https://github.com/pushkarverma3698/FounderOS/pull/627)** (`3d7a778`) — the two
tools explicitly flagged as NOT fixed at the end of the #626 session:
1. `read_cv` had no `profileId` at all. Its personal-rag REST call and wiki.md fallback are
   both structurally the founder's own data (personal-rag's own tool instructions describe it
   as "Pushkar Verma's personal knowledge base"), so a question about the second candidate
   silently answered from his background. Now skips both entirely for a non-default profile
   and reads that profile's own CV file, loud-refusing rather than falling back to his data.
2. `ingest_jobs` (the on-demand, chat-triggered pull — distinct from the daily sweep) was the
   only caller of `screenBatch` in the codebase that never passed a profile. Deeper defect:
   its title default (`DEFAULT_TITLES` in ats-source.ts) is a module-wide constant matching
   the founder's own tech tracks, not derived from any profile — an on-demand pull for a
   second candidate with no `titles` override fetched the wrong market entirely and then
   *correctly* rejected everything as off-track, which reads exactly like "no jobs exist for
   her." Both the fetch default and the screening profile now resolve from the named
   candidate, mirroring how the daily sweep (`runPooledIngest`) already does it.
3. Tightened CLAUDE.md rule #24 (Evidence over assertion): a tool-level SSH `.execute()` call
   proves the tool, not the real Telegram → planner → dispatch path a founder's message
   actually takes. New standing rule, founder directive: drive jobhunt/gateway fixes through
   Telegram (`scripts/lib/mtproto.ts`) before calling them done.

## What we fixed

See the two PR bodies for the full list; the concrete defects were:
- `queryJobState` (job_state) — no profile filter, ever.
- `listScreenedApplications` (review_screened) — same, plus the tool layer never exposed
  `profileId` either; this is the one that returned "500 postings" for both candidates in the
  founder's own manual test.
- `judge-model.ts` / `content-judge.ts` — dead model slug, then (after the fix) an
  undersized token budget on the replacement.
- `sweep-runner.ts` — in-memory heartbeat state, not persisted.
- `screen_job`, `tailor_cv`, `cv_gaps`, `job_brief`, `read_cv`, `ingest_jobs` — each missing
  profile plumbing at one or more layers (UnifiedTool schema, LangChain wrapper, or both).

## Why

The founder's own framing: two people share one pipeline, and it has to work identically well
for both, not just for the one who built it. Every defect above is the same root shape — an
optional `profile` parameter whose absence silently defaulted to either "the founder" or "no
filter at all, mixing both" — which [[brain-not-unified-no-vps-server-2026-09-05]] and
earlier multi-profile work already named as the standing risk class ("seven DB helpers whose
default was no filter at all"). This session found the 8th through 13th instances of it.

## Metrics

Live-verified against real production data post-deploy (not just unit tests):
- `job_state` — Pushkar default: 1423→1428 total (2h apart, consistent with new postings).
  Tashi via alias "Tashi": 3/3 real finance rows (Visa, HP, Baxter), zero tech bleed-through.
  Garbage profile name: loud refusal naming both registered ids.
- `review_screened` — Pushkar: 500 postings. Tashi: 80 postings (matches the ~94 measured
  earlier in the week within normal sweep variance). Previously both returned 500.
- `job_brief` — Tashi's own finance-track brief renders correctly (13 fresh / 67 aged out),
  confirming the profile fix and the 24h-window revert work together correctly.
- `read_cv` — Tashi: returns her CV from `/opt/founderos-data/cv/cv-wife-base.md`. Pushkar
  (omitted profileId): unchanged, `cv-master.md`. Neither call touched personal-rag for her.
- `ingest_jobs` — verified free (schema + title-resolution wiring) without spending real ATS
  money: her resolved default titles include `FP&A Analyst:*` and exclude `AI Engineer:*`.
  The actual paid fetch was NOT live-tested — no budget justifies spending money to prove
  string-building code that 7 mocked unit tests already cover deterministically.
- `pnpm gate` green on both PRs: lint, build, wiring, LOC ratchet (`= baseline` throughout,
  both changes landed at 399 lines against fixed source files), doc-claims, full test suite
  (3788 tests, 345 files, zero regressions either time).

## Outstanding

1. **Gateway-level (Telegram) verification is still a gap.** `TELEGRAM_TESTER_API_ID` /
   `_API_HASH` / `_SESSION` are not set in this machine's `.env`. Every verification above is
   real, live, production-data execution — but at the tool layer via SSH, not through the
   actual Telegram/planner/dispatch path. One-time setup: `npx tsx --env-file=.env
   scripts/telegram-tester.ts login` (needs the founder's own interactive Telegram login).
2. `ingest_jobs` has no spend-gate budget check, unlike the daily sweep's `runPooledIngest` —
   flagged as a separate task (`task_2cb0d5cf`), not fixed in this session (out of scope for
   what was asked).
3. A separate, unrelated local branch (`fix/vps-infra-and-stability`, 8 commits, never pushed
   or PR'd) sits in this same checkout with its own STALE judge-model change (drops `:free`
   from the dead llama-3.3 slug, landing on the same dead model's paid variant — worse than
   what it replaces, since `OPENROUTER_API_KEY` is at $0 balance). Not touched this session;
   flagged to the founder directly. Needs review before it's ever merged.
4. `main` and `beta` were resynced automatically (`chore: sync beta with main` ran clean after
   both merges this session) — no manual action needed there.
