# FounderOS — Limitations & Tech Debt

> Honest accounting of what is deferred, where the ceilings are, and what a
> developer should know **before** trusting or extending a subsystem.
>
> **Rewritten 2026-08-19 against the v3 kernel.** The previous revision was
> dated 2026-06-14 and described a system that no longer exists: "a prebuilt
> LangGraph supervisor + 7 ReAct departments, one model, ~13.9k LOC, 989 green
> tests." That architecture was audited and replaced on 2026-07-08 —
> `src/agents/office.ts` is now a **CI tombstone** that fails the build if
> recreated. Roughly half the old entries pointed at modules that had been
> deleted for six weeks. A stale limitations doc is worse than none: it is the
> first file a reviewer opens, and it was describing the wrong system with
> total confidence.
>
> Severity: **HIGH** (fix before scaling) · **MEDIUM** (address
> opportunistically) · **LOW** (note, no urgency).

## Measured state (2026-08-22, counted not remembered)

| Measure | Value | Δ since 2026-08-19 |
|---|---|---|
| Source files / LOC | 316 files · 55,510 LOC | +23 files · +5,763 |
| Test suite | 321 files · **3,499 tests**, offline, $0 | +463 tests |
| Behavioural golden tasks | 46 (`src/eval/golden-tasks.ts`) | — |
| DB tables | 29 (`src/db/schema.ts`) | +5 |
| Side-effecting tool modules / HITL-gated | 20 / **9** | — |
| Free ATS boards polled | 923 across 7 platforms | +65 (Personio) |
| Architecture ratchet | gateway-imports 0 · kernel-purity 0 · regex-routing 0 · orphan-subsystem 0 · fail-open-catch 11 · loc-budget 6 | unchanged |

Counts are from `git ls-files`, a full `vitest run` and `verify-architecture.ts` in
one session on 2026-08-22, not from the previous revision plus arithmetic.

## Review verdict

The v3 kernel is **strong on mechanism and weak on measurement.** The
contract-first design does real work: routing is a validated typed `Plan` rather
than parsed prose, action claims require code-recorded receipts, failures are
typed `FailureReport`s naming a component, and HITL writes its DB row before
`interrupt()`. Those are the parts that survive scrutiny.

What is missing is almost entirely **instrumentation**. The system can tell you
it is up; it largely cannot tell you how well it is doing. There is no latency
percentile, no retrieval quality metric, no per-task cost attribution, and no
measurement of whether the self-improvement loop improves anything. Several of
these are one query away from existing, because the columns were declared and
never written.

The second theme is **claims outrunning mechanisms** (CLAUDE.md #27). Three
separate files asserted a PII-scrubbing guarantee that no code implemented; a
trace field designed to version prompts carried a constant. These are not
correctness bugs today, but each is a statement a reader would reasonably
believe. Where a guarantee cannot be built, the honest move is to refuse the
capability, not to document the guarantee — the pattern set by
`src/infra/health-api-stubs.ts`.

---

# A. Measurement gaps

## A1. No latency percentiles — **HIGH**

`p50` / `p95` / `percentile` appear **zero times** in the repo.
`agent_results.latency_ms` is declared (`src/db/schema.ts:277`) and written by
nothing: the only caller of `writeTaskOutcome` (`src/kernel/synthesizer.ts:130`)
passes five fields and omits `latency_ms`, `cost_usd`, and `tools_used`. Every
row ever written has all three NULL.

No plumbing is needed — `TurnRecord.received_at` is already in kernel state.

- **In flight:** brief `docs/antigravity/AG-008-turn-latency-percentiles.md`.

## A2. Cost is attributable to a day, not a task — **HIGH**

`ai_call_costs` is well shaped for attribution (`agent`, `tier`, and a `lead_id`
FK commented "enables per-lead cost attribution"). The kernel writes constants
into two of those and never sets the third: `kernelCostSink`
(`src/gateway/kernel-run.ts:69`) hardcodes `agent: "kernel"`, `tier: "primary"`
for every call. Planner, workers and synthesizer are indistinguishable in the
ledger.

Daily spend and budget caps work correctly. "What does a job screen cost versus
a research task" does not.

- **In flight:** brief `docs/antigravity/AG-009-cost-attribution.md`.

## A3. No retrieval evaluation — **HIGH**

Zero occurrences of `recall@`, `nDCG`, `MRR`, `faithfulness`, or `groundedness`.
No golden retrieval set exists. The only relevance signal in the system is
`score` = fraction of query terms present (`src/db/rag-search.ts:88`), which its
own comment calls "a rough relevance."

Retrieval *failure* is handled well (keyword fallback with a visible
"Semantic search unavailable" banner; `src/infra/rag-optimization-sweep.ts`
refuses to render an empty store as full coverage). Retrieval *quality* is
unmeasured. We can prove retrieval is up; we cannot prove it is good.

- **In flight:** brief `docs/antigravity/AG-010-retrieval-eval-harness.md`.

## A4. The behavioural eval scores structure, never output quality — **MEDIUM**

The 46 golden tasks score three things: routing, tool selection, HITL coverage.
All three are structural. Nothing scores whether an answer was *correct*.
`pnpm eval` can tell you a request reached the right worker and cannot tell you
the founder got a useful reply.

Two secondary problems in the same harness:
- `src/eval/types.ts` still documents "the office", "7 ReAct departments", and
  "the supervisor" — vocabulary from the tombstoned v2. It compiles only because
  `Department` and `WORKERS` happen to list the same eight strings.
- Tasks remain hardcoded with no registry, versioning, or set selection
  (carried over from the previous revision; still accurate).

## A5. `judge.ts` is under-deployed — **MEDIUM**

`src/infra/judge.ts` already does what a reviewer probes for: a **different
model family** from the agent (specifically to avoid LLM-as-judge identity
bias), temperature 0, deterministic verdict parsing, fail-open so infra failure
never blocks the founder. It has **one caller** — `judgeOutbound` from
`src/agents/agent-tools/comms.ts:34`, grading outbound brand voice.

It never sees an answer given to the founder. The mechanism is built and pointed
somewhere narrow.

- **In flight:** brief `docs/antigravity/AG-011-answer-quality-judge.md`.

## A6. Inline guardrails exist; async evaluation does not — **MEDIUM**

FounderOS has real inline guardrails: `flagDangerousCommand`, `hitlGate`, budget
caps, `MAX_TOOL_CALLS_PER_STEP`. It has **zero** async evaluators. The two are
different instruments — a guardrail blocks a specific failure inline on a
millisecond budget; an evaluator scores quality off the hot path — and only one
side is built. Closing this rides on A5.

## A7. Self-improvement is unmeasured — **MEDIUM**

`src/evolution/` collects telemetry, ranks findings, persists them, and files a
GitHub issue. `rank.ts` orders by `SEVERITY_RANK` and `KIND_PRIORITY` —
**author-assigned labels, not measured impact**. There is no baseline and no
before/after, so there is no evidence that a shipped finding improved anything.

This is the failure mode CLAUDE.md #26 names directly. Recommended posture: say
"unmeasured" out loud rather than building a measurement layer nobody asked for.
An unfalsifiable improvement loop is worse than an honestly labelled one.

## A8. Traces are not persisted — **MEDIUM**

`startTurn` emits seam events into an **in-memory 500-event ring buffer**
(`src/infra/health.ts:35`) broadcast over SSE. Nothing durable. A restart loses
everything. journald is the de-facto trace store — `scripts/verify-benchmark-run.ts`
reads it for corroboration, which works but is not a tracing story.

---

# B. Claims that outran their mechanisms

## B1. PII-scrubbing was documented and not implemented — **FIXED 2026-08-19**

`src/infra/telemetry.ts` asserted it installed "a PII scrubber that runs before
any span is exported." It installed none — `scrubPii`/`scrubObject` had exactly
one consumer, the local pino path at `src/infra/trace.ts:89`. With
`LANGCHAIN_TRACING_V2=true`, LangChain reads that variable itself and uploads
full run I/O to LangSmith: for FounderOS, the founder's email bodies, CV,
recruiter addresses and job applications.

Latent, never live — the flag defaults to `false`. Two further copies of the
same claim were found by sweep (`.env.example:130`, `src/db/schema.ts:148`).

Fixed by refusing the export rather than faking the guarantee: langsmith 0.2.15
accepts an anonymizer only as a `Client` constructor option and LangChain builds
its own `Client`, so a global scrubber is unprovable. A refusal now **clears the
tracing env vars**, because logging "disabled" would not stop LangChain.

**Not a gap, deliberately:** model *input* is not scrubbed. The agent must see
`alex@acme.com` to email Alex. The provider is a required processor; the
observability export is optional, which is why only the latter is gated.

## B2. `promptHash` was a constant — **FIXED 2026-08-19**

`activePromptHash()` was written and unit-tested to catch prompt regressions and
had zero callers; all four `startTurn` sites passed the literal `"kernel-v3"`.
Now hashes the real corpus (planner prompt + every worker prompt).

## B3. `HITL_GATED_TOOLS` gates nothing — **MEDIUM, open**

The declared list is used for **rendering**, not enforcement. The real gate is
`hitlGate()` called inline inside each side-effecting tool — present in **9 of
20** modules in `src/agents/agent-tools/`. Nothing structurally prevents a new
side-effecting tool from shipping ungated, and nothing reconciles the declared
list against the enforced one.

This is also the honest answer to "where is your policy engine": distributed
across tools, with the declaration decorative. A fitness rule asserting every
tool in `HITL_GATED_TOOLS` actually calls `hitlGate()` would convert a
discipline into a build failure. **Recommended next fitness rule.**

---

# C. Architecture and scaling

## C1. Single-process, single-instance polling transport — **HIGH at scale**

A single grammy long-poll process behind a PID lock (`src/infra/single-instance.ts`).
Correct and 409-safe for one founder; a hard horizontal ceiling. Turns serialize
per chat (`withChatTurnLock`), so there is head-of-line blocking the moment there
is more than one user. The data layer is scale-ready (`TENANT:chatId` thread
ids); the transport is not.

- **Pre-multi-tenant re-platform:** job queue (pg-boss/BullMQ) + webhooks.

## C2. No ACL on retrieval — **LOW today, HIGH at multi-tenant**

`src/db/rag-search.ts` has no tenant or permission filter. The store boundary
(ADR-013/015, `ALLOWED_RAG_TABLES`) separates personal from business data by
*table*, which is the right call at single-tenant, but there is no row-level
authorization. Not a bug now; a blocker for any second user.

## C3. No blue-green index swap — **MEDIUM**

`brain:sync` re-embeds in place. A bad sync degrades retrieval with no
pre-cutover evaluation and no rollback. Compounded by a known failure mode:
brain grounding silently no-ops when Postgres is down. Depends on A3 — you
cannot gate a cutover on a retrieval metric that does not exist.

## C4. Degradation is error-triggered, never latency-triggered — **MEDIUM**

The failure path is genuinely good: `withModelRetry` (3 attempts, jittered
backoff, 45s attempt deadline, 90s budget), `withModelFallbacks`, and a status
taxonomy where 5xx/429 retry, 404 falls back, and 401/403 fail loud — the last
deliberately excluded because the fallback shares the key.

There is no latency-triggered degradation to a smaller model or cached response,
because nothing measures latency (A1).

## C5. `AnyTool = any` — **MEDIUM**

`src/agents/capabilities.ts:84` types tool arrays as `any` because LangChain tool
generics are heterogeneous. Tests check `.name` and invokability so the runtime
contract holds, but nothing statically prevents a non-tool entering a department
array. A minimal structural type (`{ name: string; invoke: (...) => unknown }`)
would catch the realistic mistake without fighting LangChain minors.

## C6. Prompt-injection defense is blast-radius, not detection — **MEDIUM**

Retrieved RAG chunks, web-search results, MCP tool output, and email text all
enter model context **unscanned**. The defense is HITL at the side-effect
boundary: injected instructions can influence a draft but cannot send it.

That is a legitimate and arguably correct position — detection is unreliable and
containment is not — but it should be a *stated* design choice rather than an
absence. Coverage today is one golden task
(`src/eval/golden-tasks.ts:312`, `adversarial-prompt-injection`) exercising the
comms-send path only. Related awareness is real and scattered:
`src/infra/path-guard.ts` (untrusted email/web text in scope),
`src/agents/skill-loader.ts` (untrusted-input discipline),
`src/mcp/bridge-classify.ts` (untrusted server annotations are hints, not
guarantees).

## C7. Composio remains a shared failure domain — **MEDIUM**

Unchanged from the previous revision and still accurate: one invalid Composio key
takes down multiple send paths at once, surfacing only at send time.
**Direction (ADR-041): do not expand Composio.** New integrations go through the
MCP bridge, where a dead server isolates to its own tools.

## C8. No memory decay — **LOW today**

`episodic_memory`, `founder_context`, and `failure_lessons` have no TTL, decay,
supersession, or relevance-weighted eviction. Memory grows monotonically. The
only expiry anywhere is `RESEARCH_CACHE_TTL_SECONDS` on a Redis scrape cache;
the nearest relative is `src/kernel/lessons.ts`, which discards a lesson
candidate once its retry settles — step-scoped, not memory decay.

Checkpoints *are* bounded (`CHECKPOINT_TTL_DAYS`, daily sweep). Low urgency at
current corpus size; revisit before the store affects retrieval precision.

---

# D. Resolved since the 2026-06-14 revision

Kept as a short ledger so nobody re-files them. Each verified against the tree
on 2026-08-19.

| Old item | Status |
|---|---|
| 6-layer tool wiring has no build-time check | **RESOLVED** — `scripts/verify-wiring.ts` exists and runs in `pnpm gate` |
| Config validates presence, not validity | **RESOLVED** — `src/infra/boot-validate.ts` + `src/infra/provider-probes.ts` |
| Memory search is keyword-only (ILIKE) | **RESOLVED** — pgvector `<=>` semantic search live in `src/db/rag-search.ts` |
| No daily outbound send quota | **RESOLVED** (G4) — Postgres-backed `getDailyOutboundCount()` |
| Judge cache key collides across tools | **RESOLVED** (§11) — key is `channel:tool:hash(text)` |
| Model layer drift / `FounderChatModel` | **RESOLVED** — ADR-028; plain provider models + fallback middleware |
| Context isolation enforced by convention (office.ts) | **DEAD** — `office.ts` is a CI tombstone |
| Nested supervisor not in production (revenue-domain.ts) | **DEAD** — tombstoned |
| Signal schema versioning (dept_signals) | **DORMANT** — table has no production writer |
| Redis LLM cache is dead code | **NOT TRUE** — `withLlmCache` is wired at `kernel-boot.ts:180,188` |

---

# E. Design intent — not bugs

These look like gaps and are deliberate. Do not "fix" them without reading the
reasoning first.

- **Idempotency before every external send**, HITL row before `interrupt()`,
  audit row only on real success. Textbook; leave alone.
- **Postgres checkpointer + compile-once kernel singleton.**
- **Two-gate brand → judge on a different model family, fail-open.** The
  fail-open is intentional: the human gate is the real control, and a judge
  outage must never block the founder.
- **`action_log.payload` is stored verbatim.** First-party Postgres; an audit row
  that redacts the recipient of the email it attests to is not an audit row.
- **`temperature: 0` everywhere.** Non-zero as a default is a P0.
- **Failures are never wiped from a thread.** Only `/reset`, by explicit founder
  command.
- **`brand-retry` counter is process-local** — accepted for single-tenant;
  TTL'd Postgres row is the multi-tenant fix.

---

## How to keep this file honest

The previous revision rotted because nothing checked it. Two habits, in order of
value:

1. **Prefer a fitness rule to a paragraph.** Over one month the CI-enforced
   rules in `scripts/verify-architecture.ts` drifted zero times; markdown rules
   drifted three times in a day (CLAUDE.md #27). B3 is the best current
   candidate for promotion.
2. **When an entry is fixed, move it to section D with the file that proves it.**
   An entry with no file path is a memory, and memories are what made the last
   revision wrong.
