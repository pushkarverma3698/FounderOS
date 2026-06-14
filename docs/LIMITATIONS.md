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

## 2. `model.ts` accumulated defensive layers — **MEDIUM**

`FounderChatGoogle` (~480 LOC) stacks five recovery behaviours: name-stripping,
empty-message sanitization, transient-retry with backoff, Google fallback chain,
and an OpenRouter cross-provider escape. Each exists for a real, dated Gemini SDK
quirk. It is correct but hard to read end-to-end.

- **Root cause:** workarounds for `@langchain/google-genai@0.1.x` bugs
  (no-candidates crash, empty-contents 400) and Gemini capacity 503s.
- **Path to simplify:** when the Gemini SDK is upgraded, re-test each workaround and
  delete the ones the SDK now handles. Several (`isNoCandidatesError`,
  `syntheticResponseFromLastTool`) are SDK-version-specific and should not outlive it.
- **Why deferred now:** removing any layer without first proving the SDK fixed it
  would regress a production P0 (verification-first rule).

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
