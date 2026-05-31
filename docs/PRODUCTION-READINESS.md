# FounderOS — Production Readiness Report

**Date:** 2026-05-31 · **Assessed by:** live CEO scenario battery + full test pyramid
**Live-test cost:** $0.036 (cap $0.50) · **Verdict:** **Conditionally ready** — core is solid and now reliable; a short pre-publish checklist remains before sale / open-source.

This report is evidence-based. Raw data: [`docs/livetest/ceo-battery-report.json`](livetest/ceo-battery-report.json).

---

## 1. How it was tested

| Layer | Harness | Cost | Result |
|---|---|---|---|
| Unit/integration/chaos/load/e2e | `pnpm test` (vitest, mocked + local Ollama) | $0 | **210 passed / 28 files** |
| Local capability (every agent + pod) | `scripts/qa-manual.ts` (real Ollama) | $0 | All raw-LLM + agent tests pass; pods reach HITL |
| **Live cloud CEO battery** | `scripts/ceo-live-battery.ts` (real Gemini cascade, dry-run) | $0.036 | See §3 |

The cloud battery drives the **compiled FounderGraph headlessly** with one genuine CEO task per
capability. HITL gates suspend the graph (no `sendFn` wired) → **zero real external sends**, while
still exercising routing, every pod, the critic, cost tracking and the budget guard. A hard
kill-switch aborts before any scenario once spend reaches $0.45.

Infra for the test: dedicated Postgres on **:5433** + Redis on **:6379** (so the budget guard is
actually enforceable — it fails OPEN without a DB), budget capped at **$0.50** via `scripts/qa-cloud.env`.

---

## 2. Bugs found and fixed during this test

| # | Severity | Bug | Impact | Fix | Guard |
|---|---|---|---|---|---|
| 1 | **Critical** | Migration `0001_rename_tables` was never in the drizzle journal → `setup-db.ts` only applied `0000`. Fresh DB had old table names (`llm_costs`…), code queries new names (`ai_call_costs`…). | **Every fresh install:** cost logging fails, budget guard silently fails open, cost tracking dead. | Registered `0001` in `meta/_journal.json`; rewrote it with statement-breakpoints + `IF EXISTS`. Verified on a clean DB. | n/a (verified via clean re-setup) |
| 2 | **Critical** | CEO routing tier fell to `gemini-2.5-pro` (reasoning model) at a 512-token cap (no Anthropic key). Thinking tokens exhausted the budget → **empty text** → no routing. Also the prompt echoed the full task → truncated JSON. | Gemini-only users (the target buyer) **cannot route any task**. | CEO tier → `gemini-2.5-flash`; compact CEO verdict (no task echo); cap 512→1024. | `cascade-config.test.ts`, `supervisor-routing.test.ts` |
| 3 | **High** | Supervisor's conditional edge omitted `END`, so an unresolved department threw *"Branch condition returned unknown or null destination"* and crashed the whole invocation. | Any routing miss / multi-tenant agent crashed the request. | Added `[END]: END` mapping; graph now ends gracefully. | verified live (naggar + dedup) |
| 4 | Medium | Anti-sycophancy broken without an Anthropic key: critic fell straight to `gemini-2.5-flash`, same family as the Gemini generators. | Critic could rubber-stamp the generator (self-review). | Critic tier reordered: Claude → Llama(free, non-Gemini) → Gemini. | `cascade-config.test.ts` |
| 5 | Medium | Cost-map / model-id drift: `deep_research` used `deepseek/deepseek-v4-flash:free` but the cost map keyed `deepseek-r1:free`; `veo` uncovered. | Free-fallback cost silently recorded as $0. | Aligned to `deepseek-r1:free`; coverage test added. | `cascade-config.test.ts` |
| 6 | Low | `qa-manual.ts` finished its verdict then **hung forever** on dangling Redis/scheduler handles (looked like an 18-min freeze). | QA script unusable in CI / by buyers. | Force clean exit on success. | n/a |
| 7 | Low | 4 e2e tests passed plain `{role,content}` to `callCascade` (violating the `BaseMessage[]` contract) and misread `keepRecent` as a ceiling. | False red on a correct codebase. | Tests corrected to the real contracts. | the tests themselves |

Also added for production/OSS: **`/health` + `/metrics`** HTTP server (dependency-free, tested), **`LICENSE`** (MIT), **`CONTRIBUTING.md`**, `package.json` license field.

---

## 3. Live CEO battery — results (real Gemini cascade, dry-run)

| Scenario | Routed | Reached HITL | Latency | Cost | Outcome |
|---|---|---|---|---|---|
| Prospecting (`gymshark.com`) | ✅ prospecting | n/a | 10.0s | $0.0003 | Researched + ICP-scored → **correctly disqualified** (900+ employees) |
| Sales (cold email to Stripe) | ✅ sales | ✅ | 47.2s | $0.0057 | lead_intel→sales_engineer→bdr→critic→**HITL (draft ready)** |
| Engineering (Hono Stripe webhook) | ✅ engineering | auto | 62.1s* | $0.0011 | Produced technical plan + code (local code-gen timed out, **fell back to cloud**) |
| Marketing/SEO (audit turicks.com) | ✅ marketing | ✅ | 17.6s | $0.0002 | Reached HITL |
| Social (LinkedIn post draft) | ✅ social | ✅ | 33.3s | $0.0086 | content_researcher→post_writer→critic→**HITL** |
| Naggar (multi-tenant) | ⚠️ END | n/a | 1.1s | $0.0001 | CEO picked a valid naggar ops agent with **no pod** → graceful END (see §5) |
| Dedup (5× concurrent same URL) | ✅ | n/a | — | — | **0 errors**, no crash, no duplicate work |

**Total: $0.036 / $0.50 cap. 0 crashes. 0 JSON parse failures.**
\*Engineering latency is dominated by the local `code`-tier model timing out at 30s before the cloud fallback; see §5/F1.

---

## 4. Reliability mechanisms — verified

- ✅ **Cascade fallback + circuit breakers** (opossum) — local code-gen timed out, cloud picked up.
- ✅ **Graceful degradation** — unroutable department ends cleanly; Redis/DB failures fail-open.
- ✅ **Budget guard** — enforceable now that cost rows write; kill-switch + daily cap.
- ✅ **Idempotency** — `hasBeenAudited` + audit log before any external action.
- ✅ **HITL DB-backed** — interrupt written before suspend; recoverable on crash.
- ✅ **Concurrency** — 5 simultaneous prospecting runs, zero errors.
- ✅ **Anti-sycophancy** — critic now a different family from the generator.
- ✅ **Observability** — Pino structured logs (PII-scrubbed), per-call cost in `ai_call_costs`, LangSmith, `/health` + `/metrics`.

---

## 5. Remaining gaps (prioritized for sell + open-source in 2 weeks)

| Pri | Gap | Recommendation |
|---|---|---|
| **P1** | **OSS data sanitization.** Real Turicks/Naggar business specifics live in `registry.ts` / `prompts.ts`. | Extract private profiles to a git-ignored `companies.local.ts` + ship a generic `companies.example.ts` before publishing. (Pre-publish checklist item; needs an owner decision on what stays public.) |
| **P1** | **Multi-tenant pods incomplete.** Naggar/cross-company agents (booking, farm, culinary, ops) have no execution pod → route to END. | Either add operations/content pods for non-turicks tenants, or constrain the CEO prompt per-tenant to only route to agents that have pods. |
| P2 | **Local `code`-tier reliability (F1).** `founderos:latest` times out at the 30s breaker on code generation; the system falls back to cloud but adds ~60s latency. | Document a minimum local-model requirement, or raise the code-tier timeout / drop local-first for `code` when an OpenRouter key is present. |
| P2 | **QA-script lint debt.** `qa-manual.ts` / `qa-pipeline-test.ts` have ~10 tsc errors (missing chalk types, `getGraph` not imported in qa-pipeline). `src/**` is clean. | Fix before enabling `pnpm lint` in CI. `qa-pipeline-test.ts` references an undefined `getGraph` — likely broken; verify or remove. |
| P2 | **Stub features.** Marketing content-writer, Tavily web search, Gmail send, GitHub push are stubs. | Complete or clearly label as roadmap in the README so buyers aren't surprised. |
| P3 | **Process supervisor.** No pm2/systemd unit shipped. | Add a sample `systemd`/`pm2` config + Docker `restart: unless-stopped` (compose already has it). |
| P3 | **Env footgun.** An empty `ANTHROPIC_API_KEY` in the shell fails Zod `min(1)`. | Treat empty strings as unset in `config.ts` (coerce `"" → undefined`). |

---

## 6. Go / No-Go

- **Operational use (run your own agency today):** **GO.** Routing, all five turicks pods, HITL,
  cost control and graceful degradation work on a Gemini-only budget for cents per task.
- **Sell to one-person agencies:** **GO after P1s** — finish the data sanitization and decide the
  multi-tenant story (or scope the product to a single tenant for v1).
- **Open-source on GitHub (portfolio):** **GO after P1 sanitization + P2 lint.** LICENSE/CONTRIBUTING
  are in place; the architecture, ADRs, test pyramid and this live-test methodology are strong
  portfolio signals.

The single most important fix this phase: **a fresh `setup-db.ts` now produces a working database** —
without it, every buyer's first install had silent, dead cost tracking and an unenforceable budget.
