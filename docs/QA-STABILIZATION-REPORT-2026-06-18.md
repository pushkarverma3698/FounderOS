# FounderOS QA Stabilization Report — 2026-06-18

Manual QA campaign executed per the Full Manual QA Stabilization Plan. Evidence artifacts live under `/tmp/` on the Cloud VM.

## Executive Summary

**Verdict: NOT READY for feature freeze.** The automated floor is green (1199/1199 unit tests, wiring OK), but live-path testing uncovered **multiple P0 blockers**: empty vector RAG store, HITL bypass on GitHub writes, cross-task message contamination under concurrent load, and environment gaps (gws/Ollama/personal-rag). Jarvis API smoke passes in isolation; full-stack Jarvis UI fails when the production Telegram bot shares the same token (409 conflict kills backend).

---

## Phase 0 — Baseline

| Check | Result | Evidence |
|-------|--------|----------|
| Postgres + `pnpm run setup` | PASS | Setup completed idempotently |
| `pnpm brain:sync` (full) | BLOCKED | Ollama unreachable; used `--keyword-only` (54 docs) |
| `pnpm qa:daily --skip-live --skip-integration` | PASS | `/tmp/founderos-qa/latest-daily.json` → `"ok": true` |
| `pnpm test` | PASS | 1199/1199 tests |
| `pnpm lint` + `pnpm verify:wiring` | PASS | 2 non-fatal prompt-mention warnings |
| `pnpm test:smoke:miso` | PASS | All live MISO + JARVIS HTTP checks green (×2 runs) |
| `daily-health-probe` | PASS | `status=ok database=up port=3001` |
| `pnpm qa:daily` (full, live stress) | FAIL | Free OpenRouter model slug unavailable; 1 pre-existing test env issue fixed |

---

## Phase 1 — Database Reading

### Row counts (2026-06-18)

| Table | Count | Status |
|-------|------:|--------|
| `knowledge_entries` | 54 | OK (keyword store populated) |
| `turicks_brain` | 0 | **P0 — empty vector RAG** |
| `personal_rag` | 0 | **P1 — CV/portfolio search empty** |
| `founder_context` | 1 row (seeded) | OK after `seed-founder-context.ts` |
| `episodic_memory` | 0 | OK on fresh DB |
| `hitl_approvals` | 0 pending | OK |
| `dept_signals` | 0 pending (after consume test) | OK |
| `action_log` | 1 row | OK |
| `missions` | 2+ | OK |

### State checks (`runStateChecks`)

- **HIGH:** `turicks_brain` has 0 rows → `search_turicks_brain` returns nothing → fabrication risk
- **MEDIUM:** `personal_rag` has 0 rows → jobhunt/personal RAG degraded

### Command cross-checks

| Command / API | SQL match | Result |
|---------------|-----------|--------|
| `getSystemStatus()` pending HITL | `hitl_approvals WHERE status='pending'` | PASS (0/0) |
| `countPendingDeptSignals` | `dept_signals WHERE consumed=false` | PASS |
| `getFounderContext('turicks')` | Row present with 21 keys | PASS |

---

## Phase 2 — Telegram Gateway (MTProto E2E)

**Harness:** `scripts/e2e-telegram-qa.ts` over real grammy gateway. Results: `/tmp/e2e-results.jsonl`.

### Group 1 — Read-only (sequential)

| Task | Verdict | Notes |
|------|---------|-------|
| T01 Research Linear | **PASS** | Accurate 2-line summary via search |
| T02 LangGraph news | **FAIL** | Reply: "cannot transfer back to supervisor" — dept stuck |
| T03 Unread emails | **PARTIAL** | Fail-loud: gws CLI not installed (expected in VM) |
| T04 GitHub repos | **PASS** | Real repo list returned |
| T05 Read ~/.zshrc | **FAIL** | Blocked as "secret/sensitive path" — `.zshrc` should be readable |
| T06 Context awareness | **FAIL** | No reply received (timeout) |

### Group 6 — Grounding (realistic prompts)

| Task | Verdict | Notes |
|------|---------|-------|
| T23 ICP first ask | **FAIL** | Got bot restart banner instead of ICP answer (timing) |
| T24 ICP repeat | **PASS** | Honest turicks-brain refusal, no fabrication |
| T25 Shell HITL | **PASS** | HITL card shown with exact command |
| T26 Cinematic routing | **FAIL** | Stale HITL cancel message only (prior T25 card cancelled) |

### Parallel runs (group2/3/4) — INVALID

Running multiple E2E groups concurrently caused:

- **AUTH_KEY_DUPLICATED** (MTProto session collision)
- Cross-task reply contamination (T09 received T08's GitHub issue reply)
- **P0:** T13/T09 path reported GitHub issue created **without HITL card** — `"I've created the GitHub issue..."` with NO `action_log` row

**Recommendation:** E2E must run **strictly sequential** with `E2E_INTER_TASK_DELAY_MS≥8000` and no overlapping harnesses.

### Blocked after parallel runs

- T17 (prompt injection), T15 (empty message) — MTProto `AUTH_KEY_DUPLICATED` until session clears

---

## Phase 3 — Jarvis Dashboard + Backend

### API smoke (`pnpm test:smoke:miso`) — PASS

- `GET /api/v1/health` → 200
- `GET/POST /api/v1/missions` → CRUD OK
- `POST /api/v1/sessions/:id/messages` → accepted, office async run
- SSE stream-hub publish/subscribe OK
- `WEB_GATEWAY_TOKEN` auth gate OK

### REST manual checks

- Mission create via API → phase `INIT` → `RUNNING` OK
- `GET /api/v1/audit` returns rows OK

### Browser UI (http://localhost:5173)

| Step | Result |
|------|--------|
| Page load | PASS — UI renders |
| LINKED status | FAIL — shows OFFLINE when backend crashes |
| Chat reply | FAIL — 500 errors when backend down |
| + Mission modal | PASS — modal + confirmation message |
| Mission rail | FAIL — no card when backend unavailable |
| HITL modal | FAIL — not tested live (backend 409 crash) |

**Root cause:** `pnpm dev` Telegram polling crashes with **409 Conflict** — production bot uses same `TELEGRAM_BOT_TOKEN`. Backend exits ~1s after boot, taking Jarvis API offline.

---

## Phase 4 — Office / Department Hard Tasks

**Harness:** `scripts/probe-real-task.ts` (office-level, bypasses gateway). Log: `/tmp/probe-departments.log`, `/tmp/probe-departments-2.log`.

| Dept | Task | Routing | Outcome |
|------|------|---------|---------|
| admin | cinematic-web decision | admin | Partial — no episodic hit; echoed question back |
| admin | pending signals | admin | **PASS** — "No pending cross-department signals" |
| research | Score Notion | research | **PASS** — ICP score 2, not qualified (used search_knowledge) |
| comms | (via T03) | comms | gws missing — fail loud |
| engineering | List GitHub repos | engineering | **PASS** — real repos |
| marketing | LinkedIn draft | marketing | HITL interrupt — `(none)` final reply (expected pause) |
| sales | Anthropic cold email, don't send | sales | **FAIL** — refuses to draft without calling send_email |
| personal | echo hello | personal | HITL interrupt — `(none)` final reply (expected pause) |
| jobhunt | Amsterdam AI roles + CV | jobhunt | **FAIL** — personal-rag API + wiki.md missing |

---

## Phase 5 — Workflows & Cross-Department Signals

### Workflow registry — PASS

- 3 workflows registered: `onboarding`, `outbound`, `weekly_digest`
- `parseRunArgs('onboarding company=TestCo')` parses correctly
- `tests/unit/workflows/runner.test.ts` — 23/23 PASS

### Live `/run` via Telegram — NOT VERIFIED

Blocked by MTProto session contention and backend 409. Workflow runner logic verified at unit level only.

### Cross-dept signal chain — PASS (DB path)

```
publishDeptEvent(lead_discovered) → listPending → consumePendingEvents('sales') → consumed
```

Contract validation: PASS. Signal id: `32cf7ead-2268-4253-8214-9d746a27fed6`.

---

## Bug Triage

### P0 — Release blockers

| ID | Symptom | Root cause | Fix direction |
|----|---------|------------|---------------|
| P0-1 | `turicks_brain` empty | Ollama not running; brain:sync aborted | Start Ollama + `pnpm brain:sync` on prod |
| P0-2 | GitHub issue created without HITL | T13 reply claims write with no card/audit | Investigate engineering `github_write` HITL gate + stale-thread contamination |
| P0-3 | T02 "cannot transfer back to supervisor" | Research sub-agent handoff failure | Fix dept→supervisor transfer in LangGraph prebuilt |
| P0-4 | Backend 409 kills Jarvis | Prod + dev share Telegram token | Use separate bot for dev OR disable polling in web-only mode |
| P0-5 | T06 no reply | Context/admin routing timeout | Repro sequentially; check admin dept + read_context |

### P1 — Capability gaps

| ID | Symptom | Notes |
|----|---------|-------|
| P1-1 | gws not installed | Email/calendar broken in VM — expected; prod needs `gws auth login` |
| P1-2 | personal_rag empty + API down | jobhunt degraded |
| P1-3 | ~/.zshrc blocked | path-guard false positive on dotfile in HOME |
| P1-4 | Sales refuses draft-only email | Prompt/tooling forces send_email even when user says don't send |
| P1-5 | Parallel E2E contamination | Operational — run sequential only |
| P1-6 | T26 stale HITL cancel | Expected behavior but loses user task — UX issue |

### P2 — Polish

- Jarvis dept rail decorative (no click handlers) — known
- `WEB_GATEWAY_TOKEN` not sent by frontend — known gap
- Wiring warnings: marketing/jobhunt prompt doesn't mention all tools

---

## Stabilization Gate Checklist

| Criterion | Status |
|-----------|--------|
| `pnpm qa:daily` ok | PARTIAL — pass with `--skip-live --skip-integration` |
| `pnpm predeploy` green | NOT RUN (build:all not executed this session) |
| DB stores populated | **FAIL** — turicks_brain empty |
| E2E group1/4/6 pass | **FAIL** — multiple task failures |
| E2E writes + crash recovery | NOT VERIFIED — blocked by session contention |
| Jarvis LINKED + HITL | **FAIL** — 409 backend crash |
| All 3 workflows live | NOT VERIFIED |
| Cross-dept signal E2E | PASS (DB layer) |
| P0 count = 0 | **FAIL** — 5 open P0s |

---

## Recommended Next Actions (before feature freeze)

1. **Data:** Start Ollama on prod → `pnpm brain:sync` (full vectors) → verify `SELECT count(*) FROM turicks_brain WHERE embedding IS NOT NULL > 0`
2. **HITL:** Re-run T08/T13 **sequentially** with `--approve`; verify HITL card + `action_log` row before any GitHub write claim
3. **Telegram:** Stop prod bot OR use dev-only token before Jarvis/E2E sessions
4. **E2E:** Re-run full suite sequential: `node --env-file=.env --import tsx/esm scripts/e2e-telegram-qa.ts run all --approve --realistic` (single process, ~45 min)
5. **Fix P0-2/P0-3** in code before declaring stable

---

## Evidence Index

| Artifact | Path |
|----------|------|
| Daily QA summary | `/tmp/founderos-qa/latest-daily.json` |
| E2E JSONL | `/tmp/e2e-results.jsonl` |
| E2E group1 log | `/tmp/e2e-group1.log` |
| Department probes | `/tmp/probe-departments.log`, `/tmp/probe-departments-2.log` |
| Jarvis API | `pnpm test:smoke:miso` stdout |

**Campaign executed:** 2026-06-18 on Cloud VM (local Postgres, shared prod Telegram bot token).
