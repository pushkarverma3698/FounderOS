# FounderOS — System Audit (Stabilization Plan v2, Phase 0 · Tasks 3 + 4)

> **Purpose.** A truthful, file-by-file map of the production request path, every
> point where LLM output controls control flow, every external dependency and its
> failure behavior, and a coupling classification of the departments we are about
> to disable. This document is the input to Phase 0 Task 1 (department registry +
> `DEPARTMENTS_ENABLED` allowlist) and to the Phase 5 re-enablement order.
>
> **Scope note.** The plan is written in Python-ish pseudocode (`dict[str,
> DepartmentFactory]`, `make evals`). FounderOS is **TypeScript + LangGraph JS**.
> The substance maps; the mechanics do not. This audit describes the code as it
> actually is on branch `fix/github-write-test-integrity` (2026-07-07), not the
> pseudocode.
>
> **Decisions locked for this plan (from the founder):**
> - Enabled reliable core = **research + sales + comms**.
> - Disabled (to be gated + classified below) = **admin, engineering, marketing,
>   personal, jobhunt**.
> - `revenue` and `creative` are subgraph *wrappers* (flag-gated OFF today), not
>   independent departments — treated separately.

---

## 1. The production request path (file by file)

A single Telegram text message becomes one office run. The path is **not** simply
"gateway → supervisor → department". There are **four independent routing
surfaces** and **four gateway fast-paths that bypass the office entirely**. All of
them are enumerated here because *any* of them can route to a department, so a
department is only "unroutable" when it is removed from **all** of them.

### 1.1 Ingestion → run-loop

| Step | File · function | What happens |
|------|-----------------|--------------|
| 1 | `src/gateway/telegram.ts` | grammy bot; `bot.command(...)` for slash commands, free text → `routeToOffice(ctx)`. **No `update_id` dedup** (see §5, finding U1). |
| 2 | `src/gateway/office-run.ts` · `routeToOffice` → `runOfficeText` → `runOfficeSession` | Wraps the run in `withChatTurnLock(session.id, …)` — per-chat serialization (`chatTurnChains`). |
| 3 | `runOfficeSessionLocked` | The heart. Ordered sequence below. |

### 1.2 `runOfficeSessionLocked` ordered sequence (`office-run.ts:842`)

1. `startTurn(...)` → trace seam `turn.in`.
2. `readHalt()` — global kill-switch flag-file; if engaged, refuse (`halt.blocked`).
3. `resolvePendingApproval(office, config)` — if a stale HITL interrupt is parked
   on the thread, drain it with `Command({ resume: "rejected" })` (fail-safe: side
   effects only run on `"approved"`), notify the founder. (`office-run.ts:316`)
4. `recoverWedgedThread(...)` — if `state.next` points at a half-executed node with
   no interrupt (aborted prior run), wipe the checkpoint. (`office-run.ts:354`)
5. **Fast-paths (bypass the office graph entirely — see §1.4):**
   - `tryInboxReadFastPath(text)` → **comms** capability.
   - `tryGithubReadFastPath(text)` → **engineering** capability.
   - `isShellHitlRequest(text)` → `invokeShellHitlFastPath` → **personal** capability
     (its own one-node graph, `buildPersonalShellOffice`).
   - `isGithubWriteRequest(text) && extractGithubWriteParams(text)` →
     `invokeGithubWriteFastPath` → **engineering** capability (its own one-node graph).
6. `office.getState(config)` → `baseLen` (message count before this turn, for
   fresh-message slicing).
7. `buildOfficeInput(text, activeCompany)` — **the pre-router** (`pre-router.ts:282`),
   which decides the department and injects directive SystemMessages (§1.3).
8. `assertDailyBudgetAllowsRun(...)` — Postgres cost-sum gate (fail-open).
9. `office.invoke({ messages }, invokeConfig)` wrapped in
   `withTurnTimeout(..., OFFICE_TURN_TIMEOUT_MS=180s)`.
10. `getPendingApproval(...)` — if the run paused on a HITL tool, post the
    Approve/Reject card and **stop**.
11. `sliceFreshMessages(res.messages, baseLen)` → `finalReply` + `collectToolErrors`.
12. `needsExecutionGuardRetry(...)` — deterministic anti-hallucination guard
    (`office-run.ts:688`): if the model claimed a shell/inbox/github/web/memory/
    knowledge action without calling the tool, re-invoke ONCE with a RETRY
    directive; `knowledge`/`memory` failures fall through to a safe refusal
    (`buildKnowledgeGroundingRefusal`).
13. `sendResult(...)` → trace `turn.out` (logs `inputTokens`/`outputTokens`/`usd`).
14. `recordConversationEnd(...)` + `trimThreadHistory(...)` (keep last
    `HISTORY_KEEP_TURNS=4` human turns).

### 1.3 The office graph (`src/agents/office.ts`)

- `getOffice()` → singleton; `buildOffice(checkpointer)` compiled **once** with the
  Postgres checkpointer. `applyMcpBridge()` runs first (no-op unless
  `MCP_BRIDGE_ENABLED`).
- `createSupervisor({ agents: coreAgents, llm, prompt, outputMode:"last_message",
  postModelHook: supervisorLoopGuardPostModelHook })`.
- `coreAgents` = `[admin, research, comms, engineering, …revenueAgents, personal,
  jobhunt, …creativeAgents]` (`office.ts:392`). **A department is enabled purely by
  its presence in this array** — there is no allowlist today.
- Each department is a `createAgent({ tools: DEPARTMENT_TOOLS[dept], … }).graph`
  ReAct agent, tools from `capabilities.ts` `DEPARTMENT_TOOLS`.
- `wrapSupervisorModel` / `handleSupervisorInvoke` (deterministic task-ledger +
  directive interception) **exist but are NOT wired** — `buildOffice` uses
  `llm = getModel()` directly (rolled back 2026-07-07, PR #281 caused prod loops;
  see `office.ts:244` comment). So the **LLM supervisor** makes the routing tool
  call (`transfer_to_<dept>`) based on the prompt + directives.

### 1.4 The four fast-paths (office bypass)

These run **before** `office.invoke` and short-circuit the whole graph when a
deterministic classifier matches. Each maps to a department *capability*, so
**disabling a department must also disable its fast-path** or the department is
still reachable:

| Fast-path file | Trigger | Serves dept | Bypasses |
|----------------|---------|-------------|----------|
| `inbox-fast-path.ts` | `INBOX_READ_ONLY_RE` | comms | office graph |
| `github-read-fast-path.ts` | `isGithubReadOnlyRequest` | engineering | office graph |
| `shell-hitl-fast-path.ts` | `isShellHitlRequest` | personal | office graph (own 1-node graph) |
| `github-write-fast-path.ts` | `isGithubWriteRequest`+params | engineering | office graph (own 1-node graph) |

Two of these (comms, engineering) are the enabled core; two (personal) are
**disabled departments still reachable via fast-path** — a Phase 0 Task 1 gap to close.

### 1.5 Resume path (button tap)

A HITL Approve/Reject tap re-enters the **same thread** with `Command({ resume })`
so the paused write tool runs (approve) or no-ops (reject). Fast-path approvals use
their own thread ids (`shellFastPathThreadId`, `githubWriteFastPathThreadId`);
`pendingInterruptIdForThread` checks the main thread + both fast-path variants.

---

## 2. Where LLM output controls control flow

The plan's central worry is LLM-driven control flow (the hang bug lives here).
Enumerated exhaustively:

| # | Location | LLM decision | Deterministic guardrail already present |
|---|----------|--------------|------------------------------------------|
| C1 | Supervisor routing (`office.ts` `createSupervisor` LLM) | Which `transfer_to_<dept>` tool to call, or synthesize final reply | Pre-router injects a `[ROUTING DIRECTIVE]` SystemMessage biasing the choice; `supervisorLoopGuardPostModelHook` blocks re-transfer to the same dept |
| C2 | Supervisor loop continuation | Whether to transfer again after a dept returns | `supervisor-loop-guard.ts` (deterministic) + `OFFICE_RECURSION_LIMIT=40` + `OFFICE_TURN_TIMEOUT_MS=180s` |
| C3 | Department ReAct loop (`createAgent`) | Which tool to call, when to stop | Per-dept `toolCallLimits`, `stopToolsAfterFailure` (engineering), `SEARCH_TOOL_LIMITS` (research), token budget (`maxTokens:4000`) |
| C4 | Tool argument synthesis | Field values passed to Composio/GitHub/etc. | Zod tool schemas; soft-fail detection (`isToolFailure`) |
| C5 | Final reply text | The prose returned | `needsExecutionGuardRetry` re-invokes on unbacked claims; `redactInjectionEcho`; `aiMessageLooksFabricatedKnowledge` purge |
| C6 | `FORCE_TOOL_CHOICE` (OFF) | — | Would remove LLM discretion for the first step of high-confidence intents via native `tool_choice`; unverified, flag-off |

**Deterministic (non-LLM) routing surfaces that pre-empt C1** — these are pure
functions and are the *reliable* part of routing:

1. `pre-router.ts` `preRouteDepartment` — regex `RULES` table → dept.
2. `task-ledger.ts` `detectTaskLedger` — multi-dept ordered ledgers (Monday brief,
   research→github, LinkedIn+github fan-out).
3. The four fast-paths (§1.4).
4. `eval/office-invoker.ts` `DEPARTMENTS` set — the **eval harness's own** routing
   surface (separate from prod; a Phase 1 concern — evals must exercise the real
   gateway, not this).

---

## 3. External dependencies on the path + failure behavior

| Dependency | Where | On failure / timeout today |
|------------|-------|----------------------------|
| **Postgres** (checkpointer + audit + cost + HITL rows) | `getCheckpointer()`, `db/queries.ts` | Checkpointer failure ⇒ `office.getState`/`invoke` throw → caught in run-loop catch → `turn.error` seam, founder notified. `getPendingInterrupt` calls are `.catch(()=>null)` (degrade). Daily-budget check is **fail-open** (`notifyBudgetGateDegraded`). No explicit "Postgres briefly unavailable" retry — the turn fails loud. |
| **LLM provider** (OpenRouter/Google/Anthropic via `model.ts`) | `office.invoke` | 503 → `getFallbackOffice()` retry against `AGENT_FALLBACK_MODELS` on the same thread (topology identical). Quota-exhausted / non-503 → re-thrown → `turn.error`. Malformed tool-call JSON / empty response → **not explicitly handled**; surfaces as a ReAct loop or a `finalReply` "no output" warning (§5, finding U2). |
| **Composio** (email/calendar via `comms`, `sales`, `jobhunt`) | tool bodies (`agent-tools/*`) | Tools **never throw** — return HTTP-200-with-error strings; `isToolFailure` first-line/structured detection surfaces them as `⚠️ Tool issue`. A 500/timeout that Composio returns as a body is caught; a hard network throw is caught by the ReAct agent and surfaced as a tool message. |
| **GitHub API** (`engineering`) | `githubRead`/`githubWrite` tools | Same soft-fail contract. `github_write` is HITL-gated. |
| **Telegram API** (egress) | `session.onHtml` etc. | Send failures are `.catch`-logged in notice paths; a hard failure on the main reply propagates to the run-loop catch. |
| **Ollama** (embeddings for RAG: `search_knowledge`, `search_turicks_brain`) | research/admin/personal tools | RAG outage historically **mislabeled** as "Ollama unavailable" when the real cause was an empty pgvector table (rule #22). Present behavior: tool returns an error string; surfaced as tool issue. |
| **Apify** (research scraping) | research tools | Absent token → keyless-fetch fallback (`SCRAPE_BACKEND`); failure → soft-fail string. |
| **Redis** | — | **Not on any prod send path** (SaaS-phase). No boot dependency. |
| **External MCP servers** (`MCP_BRIDGE_ENABLED`, OFF) | `applyMcpBridge` | A server that fails to connect contributes zero tools and never crashes boot (failure isolation). |

**Guards bounding the path:** `OFFICE_TURN_TIMEOUT_MS=180s` (hard wall-clock),
`OFFICE_RECURSION_LIMIT=40`, per-run budget `RUN_BUDGET_USD=0.50` /
`RUN_BUDGET_TOKENS=50k` (`BudgetGuardCallback`), daily budget `BUDGET_DAILY_USD=5`.
These are the existing analogues of the plan's Phase 1 req #7 (loop/hang detection)
— but they abort *in production*, they are **not asserted by an eval** yet.

---

## 4. Coupling map for the 5 disabled departments

Classification drives Phase 3 Task 5 (contract) and the Phase 5 re-enablement order
(`modular` first, `tangled` last).

- **`modular`** = reachable only through the standard routing interface (pre-router
  rule + `coreAgents` membership + a dept prompt); tools live in `DEPARTMENT_TOOLS`;
  no gateway fast-path, no bespoke supervisor/gateway control flow, no shared
  mutable state.
- **`tangled`** = has bespoke control flow outside the standard interface (a
  fast-path, a subgraph, hardcoded ledger membership, or special-cased directives).

| Dept | Class | Evidence / tangle points | Re-enable difficulty |
|------|-------|--------------------------|----------------------|
| **admin** | **modular-ish** | Standard ReAct agent; tools in `DEPARTMENT_TOOLS.admin`. Tangle: **hardcoded as step 1 of the Monday-brief task ledger** (`task-ledger.ts:79`) and given several bespoke `[ROUTING DIRECTIVE]` branches (`pre-router.ts:141,183,188`). No fast-path, no subgraph. | Low — clean the ledger + directives behind the allowlist. |
| **marketing** | **tangled** | Standard ReAct agent, BUT: (a) part of the LinkedIn+github **fan-out ledger** (`task-ledger.ts:73`); (b) heavy bespoke LinkedIn directives + `resolveForcedTool` (`pre-router.ts:155`, `250`); (c) wrapped by the **`revenue` subgraph** when `REVENUE_SUBGRAPH=1` (`resolveSupervisorTarget` remaps marketing→revenue). | Medium. |
| **jobhunt** | **modular** | Standard ReAct agent; tools in `DEPARTMENT_TOOLS.jobhunt`; a single pre-router regex (`JOBHUNT_RE`). No fast-path, no subgraph, not in any ledger, no forced tool. **Cleanest of the five.** | Low. |
| **personal** | **tangled** | Has a dedicated **shell HITL fast-path** (`shell-hitl-fast-path.ts`, its own 1-node graph + thread id) and bespoke SHELL-RUN directives + `resolveForcedTool("run_shell")`. Largest blast radius (shell/browser/write on the founder's machine). | High. |
| **engineering** | **tangled (most)** | **Two fast-paths** (github-read, github-write, each its own graph/thread), an **optional CTO subgraph** (`ENGINEERING_SUBGRAPH`, `engineering-domain.ts`), hardcoded in the **research→github and Monday-brief ledgers**, cinematic-build directives, and the widest set of `[ROUTING DIRECTIVE]` branches (`pre-router.ts:193–221`). | Highest. |

**Implied Phase 5 order (modular → tangled):** `jobhunt` → `admin` → `marketing` →
`personal` → `engineering`. (Adjust by demo/revenue value within ties, per the plan.)

---

## 5. Things on the path I cannot fully explain from code alone (hang-bug suspects)

Per the plan: list them explicitly; these are prime suspects for the recurring
loop/hang and are the first Phase 2 reproduction targets.

- **U1 — No Telegram `update_id` dedup at ingestion.** `telegram.ts` has no
  seen-update cache. Phase 1 req #6a ("same update twice → one execution") is
  currently **unenforced**; the only protection is per-chat serialization
  (`withChatTurnLock`), which serializes but does not dedup. *Suspect for
  double-execution under Telegram redelivery.*
- **U2 — Malformed/empty LLM tool-call handling is implicit.** No explicit branch
  for "provider returned malformed tool-call JSON" or "empty response". These
  degrade into either a ReAct re-loop (→ recursion limit → loop-recovery) or a
  `finalReply` "⚠️ No reply generated" warning. Phase 1 req #4 wants this asserted
  as *graceful degradation*; today it's incidental. *Prime hang suspect.*
- **U3 — The disabled deterministic supervisor (`wrapSupervisorModel`).** The Proxy
  that would make routing/synthesis deterministic is present but unwired after
  PR #281 caused multi-step prod loops (`office.ts:244`). The current prod path is
  the LLM supervisor + `supervisorLoopGuardPostModelHook`. Whether the loop guard
  fully covers the "chained-synthesis loop" (MEMORY: "T35 chained-synthesis LOOPS")
  is **not proven by an eval** — this is the #1 Phase 2 reproduction target.
- **U4 — Loop-recovery re-invokes the office a second time** inside the recursion-
  error catch (`office-run.ts:1124+`) with a *different* input builder
  (`buildRecoveryOfficeInput`, no directives). The interaction between a wedged
  checkpoint, `clearThreadAfterAbort`, and this second invoke is subtle and has a
  history of contradictory-directive bugs (2026-07-04 fix). Needs a crash/resume
  eval (Phase 1 req #5).
- **U5 — Two routing surfaces can disagree.** `pre-router.ts` `RULES` and
  `eval/office-invoker.ts` `DEPARTMENTS` are maintained separately; the eval can
  pass while prod routes differently. Phase 1's "test the real gateway" requirement
  exists precisely to kill this class.

---

## 6. Instruction-layer inventory (Phase 0 Task 4)

Prompt sources injected on the hot path, with approximate token counts
(chars ÷ 4). **Not changed in this phase** — inventoried for the Phase 3 Task 2
"instruction diet".

### 6.1 Static per-hop injections

| Layer | Source | ~chars | ~tokens | When injected |
|-------|--------|--------|---------|---------------|
| Supervisor prompt (incl. auto capability manifest for **all 8 depts** + `TODAY` date) | `prompts/supervisor.ts` `buildSupervisorPrompt` | 15,645 | **~3,900** | Every turn, as the supervisor system prompt (trimmed to `maxTokens:6000` budget) |
| Company context block | `buildCompanyContextBlock` | 0 for default tenant | ~0 | Only when a non-default active company is set |
| Dept prompt (on handoff) — research | `prompts/research.ts` | 4,128 | ~1,030 | When supervisor transfers to research |
| — sales | `prompts/sales.ts` | 2,833 | ~710 | on transfer |
| — comms | `prompts/comms.ts` | 2,371 | ~590 | on transfer |
| — admin | `prompts/admin.ts` | 1,607 | ~400 | on transfer |
| — engineering | `prompts/engineering.ts` | 6,524 | ~1,630 | on transfer |
| — marketing | `prompts/marketing.ts` | 9,084 | ~2,270 | on transfer |
| — personal | `prompts/personal.ts` | 7,457 | ~1,860 | on transfer |
| — jobhunt | `prompts/jobhunt.ts` | 3,360 | ~840 | on transfer |

Total prompt corpus: ~58.7KB (~14.7K tokens), but only supervisor + the one routed
dept are injected per turn (sub-agent budget `maxTokens:4000`).

### 6.2 Dynamic per-turn injections (variable)

| Injection | Source | ~tokens | Condition |
|-----------|--------|---------|-----------|
| `[ROUTING DIRECTIVE: …]` (+ CRITICAL branches) | `pre-router.ts` `buildRoutingDirective` | ~40–400 | When `preRouteDepartment` matches; branches per dept add shell/linkedin/inbox/github/cinematic detail |
| `[TASK LEDGER: …]` | `task-ledger.ts` `buildTaskLedgerDirective` | ~150–350 | Multi-dept requests |
| Internal-knowledge grounding directive | `INTERNAL_KNOWLEDGE_DIRECTIVE` | ~120 | `isInternalKnowledgeRequest` |
| `[RETRY DIRECTIVE: …]` | `office-run.ts` `buildGuardRetryMessages` | ~80–200 | Only on execution-guard retry (2nd invoke) |

**Diet observations (for Phase 3, not acted on now):** a large share of the
supervisor prompt and the dept prompts is *control-flow-as-prose* that is
**already enforced deterministically** — routing keyword tables (duplicate
`pre-router.ts` `RULES`), "call the tool / never paste a draft" instructions
(enforced by `needsExecutionGuardRetry` + `resolveForcedTool`), and capability
claims (auto-generated). These are the prime cut candidates once the eval harness
(Phase 1) can prove a cut keeps routing green.

---

## 7. Registry design implications (feeds Phase 0 Task 1)

For a disabled department to be **provably unroutable** (Task 2 acceptance), the
`DEPARTMENTS_ENABLED` allowlist must gate **all** of these surfaces, not just the
supervisor prompt:

1. **`coreAgents` array** (`office.ts`) — a disabled dept must not be in the
   `createSupervisor` agent set (removes the `transfer_to_<dept>` tool → LLM cannot
   route there).
2. **Capability manifest** (`capabilities.ts` `buildCapabilityManifest`) — must list
   only enabled depts (the supervisor prompt is generated from it).
3. **Pre-router** (`pre-router.ts` `preRouteDepartment` / `buildRoutingDirective` /
   `resolveForcedTool`) — a match on a disabled dept must return the graceful
   "not available" response, not a directive.
4. **Task ledger** (`task-ledger.ts`) — a ledger step targeting a disabled dept must
   collapse to graceful-unavailable, not a dead `transfer_to_<dept>`.
5. **Fast-paths** (inbox/github-read/shell/github-write) — must be gated by the
   allowlist so a disabled dept's fast-path is off.
6. **Eval invoker** (`eval/office-invoker.ts` `DEPARTMENTS`) + **`/q` valid-depts**
   (`commands.ts:871`) + **`/departments` help** — must be generated from the
   allowlist, never hardcoded (they are hardcoded today).

**Recommended registry shape (TS-native, not the pseudocode dict):** a single
`DEPARTMENT_REGISTRY: Record<DeptName, DepartmentFactory>` keyed by the existing
dept names, plus `DEPARTMENTS_ENABLED` (env allowlist, default
`research,sales,comms`). `buildOffice` builds `coreAgents` from
`enabledDepartments()`; the pre-router, ledger, fast-paths, manifest, and command
lists all consult the same `enabledDepartments()` helper. A route to a
disabled-but-known dept returns a defined "That capability is currently disabled"
reply; a route to an unknown dept is a bug (loud).

This is Phase 0 Task 1 — **not implemented in this PR** (audit-first, per the agreed
sequencing). This PR is documentation only.

---

*Generated 2026-07-07 · Phase 0 Tasks 3 + 4 · branch `fix/github-write-test-integrity`.
No code changed. Verification: every file/line reference above was read from source
during this audit; §7 is the design spec the Phase 0 Task 1 registry PR will implement.*
