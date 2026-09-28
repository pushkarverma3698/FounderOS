# 2026-09-28 — Gemini thinking, the cost ledger, failure replies with Retry, one command set

## What we did

- Ran the plan in `docs/plans/2026-09-28-reply-latency-and-failure-ux.md` (items 1 and 2 of the
  same day's audit, `docs/plans/2026-09-28-perf-ux-rag-audit.md`) from a cloud session, on branch
  `claude/fix-gemini-thinking-and-failure-ux` with `beta` merged in (merge commit, not a rebase).
- Checked every claim in the plan against the code and the installed libraries before building
  it. 23 corrections, each with evidence, are in the plan's new "Corrections found during
  execution" section. The biggest: the judge was missed, the cost-ledger path was described
  wrongly, the menu counts were 11 of 34 (not 17 of 34), and `config.ts` could not take the new
  env parse.
- The founder added two things mid-run: `/wife_commands` (so hiding the twins loses nothing) and a
  "🧭 Everything I can do" screen rendered from the live tool registry.
- No VPS, no MTProto, no live model call from this session. Every test is $0.

## What we fixed

1. **Latency report** (`scripts/latency-report.ts`). Journal lines in, one row per completed turn
   and p50/p90/max out, using the audit's own definition and the log-review funnel's parser.
2. **Gemini thinks at LOW** on every `google-genai:` model: planner, workers, synthesizer,
   fallbacks, the kernel's judge and the QA battery's judge, through one helper
   (`src/core/gemini-thinking.ts`). `GEMINI_THINKING_LEVEL=DEFAULT` is the rollback, preserved
   across deploys; an invalid value stops the boot.
3. **The ledger counts thought tokens** (`src/infra/token-usage.ts`). Proven through the real
   libraries: 100 in / 50 visible / 250 thoughts recorded 50 output tokens, now 300.
4. **Free-text job answers say posted and found.** `job_state` rows carry the brief's own
   `ageLine` ("posted 3d ago · found today"), computed in code.
5. **Failure replies in plain words, with 🔁 Retry** (`failure-card.ts`, `retry-button.ts`,
   `retry-callback.ts`). The re-run text comes from the checkpoint, so a card works after a restart
   and goes stale once a newer turn runs. Defects found and fixed on the way: a `/wife_draft` turn
   used to auto-retry without its profile (wrong candidate); a guest in a group could have retried
   the founder's owner-only `/task`.
6. **One command set.** The ☰ menu drops the 11 `wife_` twins (34 → 24 rows, with the new
   `/wife_commands`). Every alias stays registered and listed; CI fails if a registered command is
   on no visible surface. `/start` gained `/replied`, `/rejected`, `/remind`, `/start` and a
   "👩 Tashi's jobs" button.
7. **"🧭 Everything I can do"** on `/start`: every tool each team has, from `DEPARTMENT_TOOLS`, in
   words, marking which ask first and which the server has not set up. The home screen's team list
   now includes Jobs.

## Why

- Every tool turn made 4–5 Gemini calls, each spending ~3 s on invisible thinking (audit §1: planner
  4.2–4.8 s with default thinking, 1.6–1.7 s with a low level, same valid plan).
- The thoughts were billed but never written to `ai_call_costs`, so `/budget`, the daily cap and
  `pnpm proof:costs` undercounted every call.
- On 09-07 the founder asked "are these of today?" four times in five minutes; on 09-16 he typed
  "Try again" by hand twice; the ☰ menu was a 34-row scroll with the engineering loop below the fold.

## Metrics

- Tests at 2fe50c7: `pnpm test` 4,975/4,975 passed, 434 files, 0 skipped (baseline before this
  branch: 4,876). `pnpm ci:quality`, `pnpm verify:arch` and `pnpm gate` all exit 0. Run with the
  sandbox's `GIT_CONFIG_*` variables unset, as on CI; with them set, `claude-code-git-guard.test.ts`
  fails on `beta` before any change.
- 22 mutation probes, one per new guard: each went red and was restored.
- ☰ menu: 34 rows → 24. `/wife_commands`: 1,835 characters, one message.
- 🧭 screen: 85 rows across 8 teams, 4 messages (2,246 / 3,724 / 3,305 / 1,776 characters).
- Latency: NOT VERIFIED from here. Baseline to beat, from the audit: p50 18.6 s, p90 157 s.

## Outstanding

1. After merge and deploy, in Telegram: send "Hi", "list my 3 most recent emails" and one job
   question ("any new roles today?"); check the job answer prints "posted … · found …" per role.
2. Then: `ssh founderos-vps 'sudo -n journalctl -u founderos --since "<deploy time>" -o cat' | node --import tsx/esm scripts/latency-report.ts`
   and compare p50/p90 with 18.6 s / 157 s.
3. Look at `/start` → 🧭, `/start` → 🎯 Jobs → 👩 Tashi's jobs, `/wife_commands` and one failure
   card with 🔁 Retry on the phone (Telegram rendering of `<blockquote expandable>` is not tested).
4. One `pnpm eval` run from the laptop, to compare planner routing under LOW against the last
   scoreboard. If routing regresses, `GEMINI_THINKING_LEVEL=DEFAULT` in the prod `.env` rolls back.
5. Brain rows (turicks-brain was unreachable from the cloud session): save the corrections in the
   plan doc as decisions/bugs from a local session.
6. Follow-ups found, not fixed: `search_web`'s grounding call has no thinking config (12–16 s per
   call in the audit); Tashi's brief prints `/draft N` instead of `/draft tashi N`; Vertex models
   record 0/0 in the ledger; no `MODEL_COSTS` rows for the Gemini 3.x slugs.
