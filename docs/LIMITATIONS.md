# FounderOS — Limitations & Tech Debt

> A senior-engineer review of the live system (2026-06-14). Honest accounting of
> what's deferred, where the scaling ceilings are, and what a future developer
> should know **before** they trust or extend a given subsystem.
>
> Severity: **HIGH** (fix before scaling) · **MEDIUM** (address opportunistically)
> · **LOW** (note, no urgency). Nothing here is a correctness bug in the current
> single-tenant deployment — these are constraints and debt, not breakage.

## Review verdict

The architecture is **appropriately simple for what it is**: a prebuilt LangGraph
supervisor + 7 ReAct departments, one model, compiled once, ~13.9k LOC of source,
989 green tests. The complexity that exists is **mostly load-bearing** — the dense
spots (`model.ts`, the `office-run.ts` guards) each map to a documented production
incident with a regression test. The right move now is *documentation and
guardrails*, not aggressive rewriting; cutting the defensive layers would
re-introduce already-fixed P0s. The simplification opportunities below are real but
deliberately deferred because each one trades a small clarity win for a
reliability/churn risk on a live system.

---

## 1. The 6-layer manual tool-wiring chain — **HIGH**

Adding one tool touches 6 files in lockstep (`tools/{name}.ts` → test → wrapper →
barrel → `capabilities.ts` → `system-prompts.ts`), with **no compile-time
enforcement** that they stay in sync. This is the single biggest source of the
"errors kept recurring" history (MEMORY.md): forget a layer, get a runtime error.

- **Partly mitigated:** `capabilities.ts` is now the single source of truth, and the
  supervisor capability manifest auto-generates from it — so "what can you do?" can
  no longer drift. The wiring maps in `docs/rules/PROGRAMMING-RULES.md` document the
  exact sequence.
- **Still missing:** a build-time assertion that every tool in `DEPARTMENT_TOOLS`
  has (a) a wrapper, (b) a barrel export, and (c) a prompt mention. A small
  `scripts/verify-wiring.ts` run in CI would convert a class of runtime failures
  into a red build.
- **Why deferred:** it's net-new code (fails the YAGNI/reuse filter today at 7
  departments); revisit when department count or contributor count grows.

## 2. Model layer drift — **RESOLVED, LIVE VERIFICATION PENDING**

The old `FounderChatModel` wrapper was deleted in ADR-028. `model.ts` now returns
plain LangChain provider models selected by provider-prefixed `AGENT_MODEL` values,
and department failover uses LangChain's official `modelFallbackMiddleware`.

- **Resolved:** custom `bindTools`, manual `_generate` retry/fallback, OpenRouter
  special-case execution, and synthetic "success" responses are gone.
- **Current default:** `openrouter:openai/gpt-4o-mini` while Gemini credits are
  depleted.
- **Still required before claiming prod fixed:** live MTProto route → tool call →
  HITL approve/reject → matching `action_log` evidence with real provider keys.

## 3. `any`-typed tool arrays — **MEDIUM**

`capabilities.ts` types tools as `AnyTool = any` because LangChain tool generics are
heterogeneous across departments. Tests check `.name` + invokability, so the runtime
contract holds, but there's no static guarantee a non-tool object can't be added to
a department array.

- **Path:** a minimal structural type (`{ name: string; invoke: (...) => unknown }`)
  would catch the realistic mistake without fighting LangChain's generics.
- **Why deferred:** documented trade-off ("typing the union precisely buys nothing
  and fights every LangChain minor release") — true today; the structural-type
  middle ground is the future improvement.

## 4. Single-instance, polling gateway — **MEDIUM (scaling ceiling)**

The bot is a single grammy long-poll process guarded by a PID-file lock
(`single-instance.ts`). This is correct and 409-safe for one founder, but it is a
hard horizontal-scaling ceiling: you cannot run two instances, and a restart has a
brief poll-drain window (mitigated by `waitForProcessExit` + SIGKILL).

- **Implication for Phase E (SaaS):** multi-tenant will require webhooks + a shared
  state store and per-tenant thread isolation. The thread-id scheme (`TENANT:chatId`)
  already anticipates this, but the gateway transport does not.
- **Why fine now:** single-tenant by design (ADR-021, `main` IS production).

## 5. Postgres-only durable path; Redis unwired — **LOW**

`infra/redis.ts` exists (cache, quotas, prompt-hash) but is **not on the boot path**
and not wired into sends. The documented Phase-2 safety rails that depend on it —
`suppression_check` (do_not_contact) and `quota_check` (daily send limits) — are
**not active**. Idempotency (via `action_log`) *is* live and does prevent duplicate
sends.

- **Gap:** outbound email has no enforced daily quota and the suppression list is not
  consulted before every send. For one founder sending a handful of emails this is
  acceptable; before any volume outbound it is a **HIGH** gap.
- **Action when outbound scales:** wire `suppression_check` + `quota_check` into the
  comms/sales send path (the tables and the redis client already exist — this is
  reuse, not new infra).

## 6. Config validity vs. presence — **MEDIUM**

`config.ts` validates that env keys are *present* (Zod), not that they are *valid*.
The 2026-06-14 prod incident (every LLM call `400 API_KEY_INVALID`) passed startup
because the stale keys existed. A startup smoke-call (one cheap Gemini ping, one
Composio whoami) behind a flag would catch dead keys at deploy time instead of on the
first founder message.

- **Why deferred:** adds a deploy-time external dependency; needs a `--skip-smoke`
  escape for offline/CI. Worth doing before the next key rotation.

## 7. Composio integration fragility — **MEDIUM**

Email / LinkedIn / Calendar all route through Composio with hardcoded-default
connection ids (env-overridable). A single invalid Composio key takes down three
departments' send paths at once, and the failure only surfaces at send time. As of
the last QA, the Composio key was invalid in both dev and prod (email/linkedin/
calendar down) — see MEMORY.md.

- **Action:** treat Composio connectivity as a monitored dependency (health probe +
  `/status` surfacing), and consider a direct-API fallback for the highest-value path
  (Gmail) so one vendor outage doesn't silence all outbound.

## 8. Dead-export candidates (verify before removing) — **LOW**

`ts-prune` flags several exports as unused (parts of the `queries.ts` named-query
API, `redis.ts` helpers, `composio.ts` connection constants, `context-manager`
helpers). Most are **intentional API surface** (the query layer is meant to be the
single SQL boundary; redis is SaaS-phase). A focused pass with `knip` + manual
confirmation could remove the genuinely-orphaned ones, but this was **not done here**
because on a live system the risk (removing something a test or dynamic path needs)
outweighs the ~tens-of-lines win. Do it as its own small, test-gated PR.

## 9. Eval is non-deterministic at temp 0 — **LOW (known, accepted)**

Even at temperature 0, `pnpm eval` scores 79–90% across runs because Gemini capacity
noise reshuffles which tasks fail (the *routing* layer is unit-proven and holds; the
variance is in live model availability, not logic). Don't treat a single eval run as
a regression signal — the durable guarantee is the deterministic pre-router unit
tests, not the eval percentage.

---

## What was simplified in this pass (2026-06-14)

- Documentation-first: added `docs/diagrams/` (8 hand-authored mermaid flows) as the
  fast on-ramp for any developer — the highest-leverage "make it understandable" win.
- Fixed a mis-placed docstring in `model.ts` (the `isNoCandidatesError` doc had
  drifted above `isEmptyContentsError`).
- **Deliberately did not** rewrite the defensive subsystems (`model.ts`,
  `office-run.ts` guards) — see the verdict above. Simple ≠ stripped of hard-won
  safety; on a live system the simplest *reliable* architecture is the one whose
  complexity is documented, tested, and traceable to an incident.

## 9. Context Isolation (Phase 1) — No Runtime Validation — **MEDIUM**

The `outputMode: "last_message"` pin in office.ts enforces context isolation, but
**only if the property is never accidentally changed to "full_history"**. There is no
runtime validation that rejects "full_history" mode; the promise relies on:
- Explicit pinning in code (office.ts line 142)
- Tests that would break if changed (office-guard.test.ts)
- Code review discipline

A single PR that removes the pin or changes the value _will not crash tests_ (the
tests would have to explicitly validate the mode). Mitigation: add an explicit
startup assertion that pins the mode.

- **Action:** `if (office.supervisor.outputMode !== "last_message") throw new Error(...)`

## 10. Signal Schemas (Phase 2) — No Runtime Versioning — **MEDIUM**

Signals are validated at publish and consume time against `SIGNAL_CONTRACTS`, but
**there is no schema versioning**. If you change a schema (e.g., make a field
required), old signals in the database that don't match the new schema will:
- Fail validation during the sweep
- Be marked consumed (poison pill) to not loop forever
- Leave no durable record that they failed

Mitigation: Before changing a schema, write a backfill migration that updates
existing signals. See Phase 4 commit c289e50 for the pattern.

- **Action:** Add a `schema_version` field to dept_signals; migrations transform old signals before consuming.

## 11. Judge Memoization (Phase 3) — Single Redis Key Namespace — **LOW**

Judge caches drafts for 60 minutes using a cache key based on hash(content). If two
different tools (linkedin_post and send_email) produce identical copy, they reuse the
same cached judgment. This is correct semantics (same copy, same evaluation) but
could cause false confidence if one tool's context is slightly different (e.g.,
LinkedIn-specific restrictions the email draft doesn't have).

- **Action:** Include tool_name in the cache key: `judge:${hash(content)}:${tool_name}`

## 12. Memory System (Phase C) — Keyword-Only Search — **MEDIUM**

`search_knowledge` and `search_personal_rag` are keyword-based (ILIKE) with no
semantic ranking. Queries like "LangGraph patterns" return good results because
"LangGraph" is a literal word in the docs, but semantic similarity queries (e.g.,
"multi-agent orchestration") may miss relevant documents that use different
terminology.

- **Roadmap:** Phase E will migrate to Chroma for semantic search + ranking.
- **Workaround:** Add keyword aliases or query synonyms to the documents.

## 13. Eval Harness (Golden Tasks) — Hardcoded, Not Managed — **MEDIUM**

The 24 golden tasks for eval (routing, tool-selection, HITL coverage) are hardcoded
in `src/eval/golden-tasks.ts`. There is no task registry, no versioning, and no
facility to add new golden tasks without editing source. This is deliberate (golden
tasks are sacred — they must be curated carefully), but it means:
- Adding a new department requires manually adding 2-3 new golden tasks
- No way to disable a task without a code change
- No ability to A/B test different task sets across branches

- **Action:** Consider a YAML registry + a `--golden-task-set` flag for branch-based customization.

## 14. Nested Supervisor (Phase 5) — Not Yet in Production — **MEDIUM**

The hierarchy proof (revenue-domain.ts) demonstrates that nesting works to 3 levels,
but **it is not wired into the live office graph**. This is intentional:
- Real business trigger needed (revenue dept > marketing + sales)
- Full MTProto QA required before promoting (not just unit tests)
- Token budget impacts unknown at 2-3 nesting levels

If you promote Phase 5 to production:
- Sub-supervisors MUST pin `outputMode: "last_message"` (now enforced at runtime by
  `assertContextIsolation` — a `"full_history"` change throws at office build; see G5 below)
- Monitor token consumption (each level adds ~500 tokens of overhead)
- Test full HITL flow on real Telegram (not just unit tests)

---

## Architecture audit — 2026-06-16 (senior agentic-AI review)

Full gaps/limitations review at the "final architecture" freeze point. Verdict:
**well-built single-tenant system; the gaps cluster in (1) failover, (2) single-process /
single-tenant scaling ceiling, and (3) guarantees enforced by discipline not runtime.**
Four were fixed immediately (PR `feat/stabilization-hardening-g1-g2-g5-g9`); the rest are
tracked here as the pre-scale hardening backlog. **None are correctness bugs today; all
become incidents at scale.**

**Fixed 2026-06-16:**
- **G1 — OpenRouter failover unarmed in prod (was CRITICAL).** Cross-provider fallback in
  `model.ts` is gated on `OPENROUTER_API_KEY`; unset in prod = Gemini outage takes the whole
  office down (it was firing — credits depleted). Boot now warns loudly. **Remaining ops
  action: set `OPENROUTER_API_KEY` in prod `PROD_DOTENV` + verify a turn lands on GPT-4o-mini.**
- **G2 — `consumePendingEvents` non-atomic (was HIGH).** Now `FOR UPDATE SKIP LOCKED`, true
  exactly-once under concurrency. Verified live on real Postgres.
- **G5 — context isolation enforced by convention (was HIGH).** `assertContextIsolation` now
  throws on any `outputMode` ≠ `"last_message"`; structural test forbids the `full_history`
  literal under `src/agents`.
- **G9 — ghost `hitl_approvals` rows (was MEDIUM).** Pending approvals are now cancelled on
  reject / abort / wedge / `/reset`, so the daily stale-reminder can't nag about a wiped thread.

**Deferred backlog (do BEFORE flipping any scaling lever or the CTO subgraph flag):**
- **G3 — single-process transport is the scaling wall — HIGH.** PID-lock + grammy long-poll +
  inline ≤14s backoff serialize all work (head-of-line blocking at multi-user). Data layer is
  scale-ready; transport is not. Pre-Phase-E re-platform: job queue (BullMQ/pg-boss) + webhooks.
  (Extends §4.)
- **G4 — no daily send-quota ceiling — HIGH.** `suppression_check` IS wired (`comms.ts`, better
  than §5 implies) but `quota_check` is nowhere. Add a Postgres-backed daily send counter on the
  post-approval `send_email`/`linkedin_post` path (don't depend on unwired Redis).
- **G6 — budget mis-prices fallback models + judge is off-budget — MEDIUM.** `BudgetGuardCallback`
  prices every call as the constructor `modelId`; lite/judge/OpenRouter calls are mis/uncounted.
  Read the actual model per call (`generationInfo`) and fold judge tokens into the run budget.
- **G7 — `is503Error` substring-matches "500" anywhere — MEDIUM.** Free-text matching can route a
  real app-level failure into the retry/fallback loop (violates rule #19.5 fail-loud). Match on
  structured status codes / error classes.
- **G8 — brand-retry counter is process-local — MEDIUM.** `brand-retry.ts` Map resets on restart
  and is per-process; the convergence cap weakens on restart/scale. Move to checkpointer state or
  a TTL'd Postgres row keyed by thread+channel.
- **G10 — injection defense is prompt-level; `run_shell` args unguarded — MEDIUM.** Add a
  deterministic destructive-pattern check on `run_shell` (surfaced on the HITL card) and treat
  tool-result content as untrusted before it re-enters the model (tool-output re-injection).
- **G11 — CTO subgraph unit-proven, not live-proven; eval non-deterministic — LOW.** Before
  `ENGINEERING_SUBGRAPH=1`: run the full MTProto `e2e-telegram-qa.ts` against the nested topology
  N times, assert nested-HITL approve/reject + token overhead. (Extends §14.)
- **G12 — scheduler compiles a second `MemorySaver` office — LOW (partially fixed 2026-06-16).**
  The per-fire `buildOffice(new MemorySaver())` inside `sendMondayBrief` is now memoised via
  `getSchedulerOffice()` so the graph compiles only once. Remaining: Monday-brief LLM calls still
  bypass the budget guard, trace seam, and halt switch. Route scheduler LLM work through the
  guarded run path, or document it as unguarded.

**Do NOT change (already textbook):** idempotency on external sends · HITL pure-before-gate
contract · Postgres checkpointer · compile-once office singleton · `maxRetries:0` on the Google
SDK · two-gate brand→judge (different model family, fail-open).

---

## Design intent clarifications (not bugs)

### Rule #4 doc/reality mismatch

CLAUDE.md Rule #4 states: "Always write to the `hitl_approvals` table BEFORE calling LangGraph
`interrupt()`."

**The real code does not do this.** `hitlGate` calls `interrupt()` directly with no DB pre-write.
Crash-safety for pending HITL approvals comes from the **LangGraph Postgres checkpointer**: the
graph state (including the pending interrupt node) is persisted before the process can crash, so
a restart resumes correctly without needing a separate DB pre-write.

The `hitl_approvals` table IS written — but it's written on the `approve` callback path, not
before `interrupt()`. Rule #4 as written is aspirational; the actual safety guarantee (checkpointer
persistence) is stronger and simpler.

**No code change needed.** The current implementation is correct. The CLAUDE.md rule should be
updated in a future pass to accurately describe the checkpointer-based guarantee.

### H3 — brand-retry in-memory counter (accepted design choice)

`src/infra/brand-retry.ts` uses a process-scope `Map` to count retry attempts. A process restart
mid-oscillation resets the counter, which could theoretically bypass the convergence cap.

This is **accepted** because:
- Brand validation oscillation happens within seconds of a single ReAct turn
- A deploy mid-oscillation (a few seconds) is extremely rare
- The oscillation cap (`BRAND_MAX_RETRIES=2`) exists to prevent runaway loops, not to survive
  multi-process deployments

**Permanent fix path (when needed):** move the counter to a TTL'd Postgres row keyed by
`thread_id + channel` (see G8 above). This is the right fix for Phase E multi-tenant.

