# FounderOS — Production-Readiness Assessment

_Audit date: 2026-06-11 · Branch: `prod-hardening` (off `fix/engine-swap-reliability`) · Auditor: SRE/QA pass_
_Full command-by-command trail: [`docs/AUDIT_LOG.md`](AUDIT_LOG.md). Every claim here is backed by a pasted command result in that log._

> **Bottom line:** FounderOS is **substantially healthier than the audit brief assumed** (the brief was written against an older baseline). Build is clean, 850 unit/integration tests pass, the resilience layer is mature, and every headline safety invariant (crash-recovery, idempotency, path-guard, HITL approve/reject) was **proven for real**. The genuine defects found were a broken build-command wrapper and a dishonest eval (conflated infra errors, falsely advertised determinism) — both fixed. The remaining gap is **routing non-determinism on ambiguous departments**, which is inherent to the LLM, not a crash bug.

---

## 1. What was actually broken (reproduced baseline)

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | **Every documented `pnpm` command failed on a fresh clone** — `pnpm-workspace.yaml` shipped a placeholder `allowBuilds` block (literal `"set this to true or false"` strings) → 3 optional native deps stuck "pending" → pnpm 11 `verifyDepsBeforeRun` failed `pnpm test`/`lint`/`eval` with exit 1. The README's own test command did not run. | **HIGH** | ✅ Fixed (`8f3981d`) |
| 2 | **Eval conflated INFRA_ERROR with WRONG_ROUTE** — a model error caught by the runner became `route:null`, scored identically to a genuine misroute, silently deflating the capability number. | **MEDIUM** | ✅ Fixed (`52e3e9d`) |
| 3 | **Eval report falsely claimed "A deterministic evaluation"** — two identical-code runs at temp 0 flipped 3 tasks (mktg/sales/brand). | **MEDIUM** | ✅ Fixed (`52e3e9d`) |
| 4 | **README numbers stale/inconsistent** — badge "730 passing" (actual 850), "13 golden tasks" (actual 29), "MemorySaver checkpointer" (actually Postgres), eval table (2026-06-08, 88%) ≠ committed `EVAL.md` (86%) ≠ fresh run (83%). | **MEDIUM** | ✅ Fixed (README updated) |
| 5 | **Routing non-determinism on ambiguous depts** — sales↔research, comms↔sales, and a marketing tool-call drop flip run-to-run at temp 0. | **MEDIUM** | ⚠️ Inherent (mitigated, not eliminated) |
| 6 | `workflow-weekly-digest` consistently routes to `none` from natural language (works via `/run weekly_digest`). | LOW | ⚠️ Open (acceptable) |
| 7 | `pnpm start` → `dist/index.js` but tsc emits `dist/src/index.js`. Production runs via `tsx`, so unused. | LOW | ⚠️ Open (cosmetic) |

**The brief's lead hypothesis ("transient 503 → silent `route:none` → quiet death") was largely FALSE on this branch.** `src/agents/model.ts` already implements retry+backoff `[2s,4s,8s]` → Gemini→`gemini-2.5-flash-lite` → OpenRouter/GPT-4o-mini (live, key present) → loud throw; empty candidates never fabricate success; and the Telegram gateway surfaces every thrown error as a visible "❌ Error". The conflation survived **only** in the eval harness (issues #2/#3).

---

## 2. What was fixed (with evidence)

### Fix 1 — Build commands runnable (`8f3981d`)
`pnpm-workspace.yaml` corrected to valid `ignoredBuiltDependencies`/`onlyBuiltDependencies` + `verifyDepsBeforeRun: false` + `.npmrc`.
**Before:** `pnpm lint` → exit 1 (`runDepsStatusCheck` throw). **After:** `pnpm lint` → `$ tsc --noEmit` exit 0; `pnpm test tests/unit/eval` → 35/35 green.

### Fix 2/3 — Eval honesty (`52e3e9d`, TDD)
`isInfraError()` + `TaskResult.infraError`; `aggregate()` excludes infra-errored tasks from every capability denominator and reports `EvalReport.infraErrors`. Report drops the false "deterministic" claim, adds the honest temp-0 caveat, and surfaces excluded infra errors.
**Before:** eval unit 35 tests, infra error == routing miss, header "A deterministic evaluation." **After:** 42 tests (+7), infra errors isolated, honest header. Full suite 843→**850 green**, tsc exit 0.

### Fix 4 — Truthful README (this audit)
Badge → 850; eval table → freshly generated numbers + non-determinism caveat; "13"→"29" golden tasks; "MemorySaver"→"Postgres"; architecture diagram → current 7 departments.

### Safety probes added (`4c42287`)
`scripts/probe-crash-recovery.ts` — reusable cross-process crash-recovery proof.

---

## 3. What is still broken or limited (honest)

- **Routing non-determinism (issue #5)** — Gemini is not bit-reproducible even at temp 0; genuinely ambiguous tasks (sales vs research, comms vs sales) flip run-to-run. Mitigated by the deterministic pre-router hint + `/q` direct-route, but a single eval number is a point estimate, not a guarantee. **Not fixed by prompt edits this session** — doing so risks regressing other routes and can't be proven stable in one run (would violate the evidence rule).
- **Degraded live tools** — `COMPOSIO_GMAIL_CONN_ID` is **unset** (Gmail read errors live); **Firecrawl returns 402** (no credits). Both are mitigated (Firecrawl→`search_web` fallback; Gmail read simply fails loud), but two advertised integrations are not currently functional.
- **Not load-tested** — a sustained synthetic 503 storm and a high-concurrency soak test were **not** run (no fault-injection/load harness this session). The retry/fallback is unit-tested and a real `search_web` 503 was handled live, but burst behavior at scale is unproven.
- **Per-tool live side effects** — only comms (email, send-once, live) and personal (shell, reject, live) were driven through a full real write cycle. engineering/marketing/sales write tools were not fired live (real GitHub push / LinkedIn post). The shared interrupt→resume→idempotency→audit machinery IS proven.
- **Single-tenant** — `TENANT` is hard-wired to `turicks`; multi-tenant isolation is a SaaS-phase concern, untested.

---

## 4. Per-department status

| Department | Routing (live) | Tooling | HITL gate | Live write cycle | Verdict |
|------------|----------------|---------|-----------|------------------|---------|
| research | ✅ | search_web (Gemini-grounded) | n/a | n/a | **Works live** |
| comms | ✅ | send_email ✅ / read_emails ⚠️(Gmail conn missing) | ✅ | ✅ send-once live | **Works live** (read degraded) |
| engineering | ✅ | github / project_workflow | ✅ | ⚠️ not fired live | **Works (write untested live)** |
| marketing | ✅ | linkedin_post (tool-call flaky) | ✅ | ⚠️ not fired live | **Works (flaky)** |
| sales | ✅ (route flaky) | search_web + send_email | ✅ | ⚠️ not fired live | **Works (route flaky)** |
| personal | ✅ | read_file/run_shell/send_file | ✅ | ✅ reject-path live | **Works live** |
| jobhunt | ✅ | search_jobs / read_cv | ✅ | n/a | **Works (Firecrawl→web fallback)** |

---

## 5. Go / No-Go

### ✅ GO — for **you + a few trusted users, behind HITL**
Justified: build clean; 850 tests green; crash-recovery, idempotency, path-guard, and HITL approve/reject **proven for real**; every external action is gated and surfaced. Worst realistic failure modes are a *visible* error message or a *needs-re-approval* prompt — not a silent unsafe action. This is exactly the safety posture for a single-founder operator tool.

### ❌ NO-GO — for **unsupervised public / multi-tenant** use
Blockers: routing non-determinism (a public user hitting an ambiguous request gets inconsistent behavior); no multi-tenant isolation testing; two degraded integrations (Gmail/Firecrawl); no load/concurrency proof; per-tool live side effects largely unexercised.

---

## 6. Top 5 highest-leverage next steps (ranked)

1. **Make routing deterministic where it can be** — expand the pure-function pre-router (`src/gateway/pre-router.ts`) to cover the ambiguous pairs (sales↔research, comms↔sales) with keyword rules + unit tests, so routing stops depending on LLM tie-breaks. Highest leverage on the one real remaining defect.
2. **Add an eval-stability gate** — run the golden set N×3 in CI and assert per-task pass-rate ≥ threshold (flag any task that flips). Turns the now-honest eval into a regression guard against non-determinism.
3. **Fix or formally disable the degraded integrations** — set `COMPOSIO_GMAIL_CONN_ID` (or remove read_emails from the advertised surface) and resolve Firecrawl billing (or delete it — `search_web` already covers it). Don't ship tools that error.
4. **Drive every write tool through one real live side-effect test** (a dedicated test GitHub repo, a throwaway LinkedIn draft, a test inbox) so the approve→resume→side-effect→audit cycle is proven per-tool, not just for comms/personal.
5. **Add a 503-storm + concurrency soak** behind a fault-injection flag so the resilience layer is load-proven, not just unit-proven.
