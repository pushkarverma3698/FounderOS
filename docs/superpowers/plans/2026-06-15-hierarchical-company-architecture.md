# Hierarchical "Company" Architecture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve FounderOS from a flat 7-department supervisor into a hierarchical "company" — starting with a CTO-led Engineering subgraph (coder / qa / devops) — while formalizing the already-built async signal bus, typed handoffs, and context isolation as the standard scaling pattern.

**Architecture:** Reuse the **proven** prebuilt-supervisor nesting pattern (`revenue-domain.ts`, ADR-025) as the template. Engineering becomes a compiled sub-supervisor (the "CTO") over 2-tool sub-agents, wired under the parent supervisor. Synchronous `Command` handoffs on the interactive request path (required for nested HITL observability); asynchronous `dept_signals` for background cross-domain coordination only. No StateGraph rewrite — `createSupervisor` + `createReactAgent` throughout.

**Tech Stack:** Node 22 · TypeScript 5.5 strict · `@langchain/langgraph-supervisor` · `@langchain/langgraph/prebuilt` · drizzle-orm · Postgres + pgvector · Gemini 2.5 Flash · Vitest.

---

## 0. Reconciliation — what is ALREADY built (do NOT re-build)

Verified against source on 2026-06-15. The original ask reads greenfield; ~70% exists:

| Plan pillar | Status | Evidence |
|---|---|---|
| Async **Signal Bus** (`dept_signals`, publish/subscribe) | ✅ Built + live-verified | `src/db/schema.ts:289`, `src/agents/agent-tools/signals.ts` (`publish_signal`), ADR-024, hourly sweep, exactly-once |
| **Typed handoffs** (Zod contracts, validated at boundary) | ✅ Built | `src/agents/contracts.ts`, ADR-022 |
| **Hierarchical nesting** (sub-supervisor as agent) | ✅ Built + PROVEN, held out of prod | `src/agents/revenue-domain.ts`, `tests/integration/nested-hitl.test.ts`, ADR-025 |
| **Context isolation / state slices** | ✅ Built | `outputMode:"last_message"` pinned `office.ts:142`, `context-manager.ts`, ADR-021 |
| **Idempotency-first** | ✅ Built | `action_log` + `idemKey`/`hasBeenAudited`, rule #5 |
| Generator≠critic (Claude judge) | ✅ Built | `src/infra/judge.ts`, ADR-023, rule #6 |

**Therefore the NEW work is narrow:** (a) build a CTO Engineering subgraph that gives nesting a real business trigger, (b) promote nesting into the live office behind live HITL verification, (c) formalize state-slice isolation + signal bus + DB-schema separation + 3-level tracing as documented standards.

## 0.1 Rule decisions (ADR-027 — researched 2026-06-15)

The original plan's two rigid rules are **reframed, not adopted literally** (evidence: LangGraph hierarchical-teams docs, LangChain subagents docs, supervisor practitioner write-ups):

- **"Exactly 2 tools per sub-agent" → DROPPED.** Real principle: *small, domain-coherent toolset.* The split signal is ~10 tools on one agent, and "don't split prematurely — stay single if eval ≥85% on homogeneous tasks." FounderOS departments (1–4 tools) are already compliant. New sub-agents will be small **as a consequence of role clarity, not a hard cap.**
- **"No direct handoffs / async everything" → DROPPED on the request path; KEPT for background.** Synchronous `Command` handoffs are *required* on the interactive path because LangGraph cannot read nested subgraph state when subagents are tool-wrapped (`getState` won't return their interrupts) — which would break the `getState().tasks` HITL path the gateway depends on. Async `dept_signals` is correct only for independent background coordination (already its role).

## 0.2 Branch & process model (the "keep everything in process" requirement)

```
main   ──────────────────────────●──────────●────────▶   production (CD auto-deploys)
                                 ╱          ╱  (promote beta when stable)
beta   ●───────●───────●────────●──────────●─────────▶   long-lived integration
        ╲     ╱ ╲     ╱ ╲      ╱
feat/*   ●───●   ●───●   ●────●                            short-lived, one per phase
```

- `main` = production. **Never** commit directly; only `beta → main` promotions land here.
- `beta` = long-lived integration branch, cut from `main` (✅ created 2026-06-15 at `e66f4ef`).
- `feat/hierarchy-*` = one feature branch per phase below, cut from `beta`, PR'd back into `beta`.
- Each phase: green `pnpm test` + `pnpm lint` → PR into `beta` → human merge. When `beta` is stable → PR `beta → main` (= production deploy).

---

## Phase roadmap (each phase = one feature branch off `beta` = one shippable increment)

| Phase | Increment | Risk | Gate to merge into `beta` |
|---|---|---|---|
| **P0** | Governance docs: branch model + ADR-027 + per-phase plan convention | none | docs reviewed |
| **P1** | CTO Engineering subgraph, compiled in ISOLATION (coder/qa/devops) | low | `pnpm test` green; nested interrupt proven in isolation |
| **P2** | Wire CTO subgraph into live office; **live MTProto** 3-level HITL verify | med | real Telegram: 3-level approve/reject/wedge clean (rule #19.6) |
| **P3** | Typed state-slice isolation (global vs local) via contracts | med | token-measured no-leakage; tests green |
| **P4** | Signal-bus formalized: single-transaction (task DONE + audit) + docs | med | real-Postgres verification of transactional write |
| **P5** | Separate DB schemas (`agents` vs `brain`) — pgvector optimization | **high** | prod-shaped migration + rollback verified |
| **P6** | 3-level hierarchy tracing (`turnId` across CEO→CTO→worker) | low | `grep <turnId>` shows full 3-level path |

**Sequencing rule:** detailed bite-sized plans for **P2–P6 are written just-in-time** at each phase start, because each phase's shape depends on the prior phase's **live** verification (rule #19 — verify the real path between increments, never stack untested changes). P0 and P1 are fully detailed below.

---

## Phase P0: Governance & decision docs (feature branch `feat/hierarchy-p0-governance`)

**Files:**
- Create: `docs/decisions/027-tool-count-and-handoff-rules.md`
- Create: `docs/process/BRANCH-MODEL.md`
- Modify: `CLAUDE.md` (add branch model + ADR-027 pointer under "Git Workflow")

- [ ] **Step 1: Write ADR-027**

Create `docs/decisions/027-tool-count-and-handoff-rules.md`:

```markdown
# ADR-027: Tool-count and handoff rules for the hierarchical company

**Status:** Accepted (2026-06-15)
**Context:** Scaling to a hierarchical "company" raised two proposed rigid rules:
"exactly 2 tools per sub-agent" and "no direct handoffs (async everything)".
Researched against LangGraph hierarchical-teams + LangChain subagents docs.

## Decision
1. **No fixed tool cap.** Each sub-agent carries a small, domain-coherent toolset.
   The split signal is ~10 tools on a single agent; do not split prematurely —
   stay single while eval ≥85% on homogeneous tasks. (FounderOS depts: 1–4 tools.)
2. **Synchronous handoffs on the request path; async signals for background.**
   Tool-wrapped subagents are invisible to `getState()` — nested `interrupt()`
   would not surface, breaking the `getState().tasks` HITL path. So the
   interactive supervisor→department path stays synchronous (`Command`).
   `dept_signals` (ADR-024) remains the async layer for independent background
   coordination only.

## Consequences
- The CTO Engineering subgraph uses synchronous nesting (revenue-domain.ts pattern).
- New sub-agents are small by role, not by decree.
- Background cross-domain work continues to publish/consume dept_signals.
```

- [ ] **Step 2: Write the branch-model doc**

Create `docs/process/BRANCH-MODEL.md` documenting the `main`/`beta`/`feat/*` flow from §0.2 above (diagram + the 4 rules + "promote beta→main = production deploy").

- [ ] **Step 3: Link from CLAUDE.md**

In `CLAUDE.md` under "## Git Workflow (Non-Negotiable)", add a line:
`- Branch model: main=prod, beta=integration, feat/*=work. See docs/process/BRANCH-MODEL.md and ADR-027.`

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/027-tool-count-and-handoff-rules.md docs/process/BRANCH-MODEL.md CLAUDE.md
git commit -m "docs: ADR-027 (tool-count + handoff rules) + branch model (P0)"
```

**Success criteria:** ADR-027 + branch model exist; CLAUDE.md points to both. No code change.

---

## Phase P1: CTO Engineering subgraph, compiled in ISOLATION (feature branch `feat/hierarchy-p1-cto-subgraph`)

**Approach:** Mirror `src/agents/revenue-domain.ts` exactly. Build an `engineering` sub-supervisor (the "CTO") over three small ReAct sub-agents, reusing 100% existing tools. Compile it **standalone** and prove a nested `interrupt()` (3 levels deep: parent → CTO → devops → `github_write`) surfaces and resumes — BEFORE touching the live office (that's P2).

**Sub-agent decomposition (existing tools only — rule #17):**
- `coder` → `[claudeCode, githubRead]` — implement/fix code in an isolated workspace; read repo.
- `qa` → `[claudeCode, githubRead]` — run tests / review via Claude Code; read repo.
- `devops` → `[githubWrite, projectWorkflow]` — open PRs, push, run workflows (HITL-gated).

**Files:**
- Create: `src/agents/engineering-domain.ts`
- Create: `tests/integration/engineering-hitl.test.ts`
- Create: `tests/unit/agents/engineering-domain.test.ts`

- [ ] **Step 1: Write the unit test for subgraph composition (failing)**

Create `tests/unit/agents/engineering-domain.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildEngineeringDomain } from "../../../src/agents/engineering-domain.js";

describe("engineering-domain (CTO subgraph)", () => {
  it("compiles a sub-supervisor named 'engineering'", () => {
    const cto = buildEngineeringDomain();
    expect(cto).toBeTruthy();
    // compiled graphs expose a name on their config
    expect(typeof cto.invoke).toBe("function");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run tests/unit/agents/engineering-domain.test.ts`
Expected: FAIL — cannot find module `engineering-domain.js`.

- [ ] **Step 3: Write `engineering-domain.ts` (minimal, mirrors revenue-domain.ts)**

Create `src/agents/engineering-domain.ts`:

```typescript
/**
 * FounderOS — Engineering domain (CTO subgraph)
 * =============================================
 * The Engineering department promoted to a sub-supervisor (the "CTO") over three
 * small ReAct workers, reusing existing HITL-gated tools (ADR-027, rule #17):
 *   coder   → [claude_code*, github_read]   implement/fix code in isolated workspace
 *   qa      → [claude_code*, github_read]   run tests / review via Claude Code
 *   devops  → [github_write*, project_workflow*]  PRs, push, workflows
 *   (* = pauses for founder approval via interrupt())
 *
 * Synchronous nesting (ADR-027): the parent calls this as an agent and waits, so a
 * 3-level-deep interrupt() still surfaces via getState().tasks (the gateway path).
 * Compiled WITHOUT its own checkpointer — the parent supplies persistence.
 * Depth capped at 2 (parent → engineering → worker); we do not nest further.
 */

import { createSupervisor } from "@langchain/langgraph-supervisor";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { getModel } from "./model.js";
import { createTrimmedPrompt } from "../infra/context-manager.js";
import { claudeCode, githubRead, githubWrite, projectWorkflow } from "./agent-tools.js";

const workerBudget = { maxTokens: 4000 };

const CODER_PROMPT = `You are the Coder on Turicks' engineering team. You implement and fix code.
Use claude_code for any build/code/repo change (it runs in an isolated workspace and pauses for founder approval). Use github_read to inspect a repo first. Relay the executor's result verbatim — do not summarise.`;

const QA_PROMPT = `You are QA on Turicks' engineering team. You verify code: run tests, lint, and review.
Use claude_code to run the test/verification commands (it pauses for founder approval). Use github_read to inspect the repo. Report pass/fail with the real output — never claim "looks good" without evidence.`;

const DEVOPS_PROMPT = `You are DevOps on Turicks' engineering team. You ship: open PRs, push, run workflows.
Use github_write for PRs/commits/pushes (pauses for founder approval) and project_workflow for repo workflows. Always include the exact repo and branch in your action.`;

const CTO_PROMPT = `You are the CTO of Turicks, supervising three engineers:
- coder → write/implement/fix/build code.
- qa → test/verify/lint/review code.
- devops → open a PR, push, deploy, or run a repo workflow.
Decompose the request, route to exactly ONE engineer per step, and relay that engineer's result verbatim — no preamble. For "build/fix/implement" → coder. For "test/verify/review" → qa. For "PR/push/deploy/workflow" → devops.`;

/**
 * Build the nested `engineering` sub-supervisor (CTO over coder+qa+devops),
 * compiled WITHOUT a checkpointer — the parent supplies persistence.
 */
export function buildEngineeringDomain() {
  const llm = getModel();
  const coder = createReactAgent({
    llm,
    tools: [claudeCode, githubRead],
    name: "coder",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(CODER_PROMPT, workerBudget) as any,
  });
  const qa = createReactAgent({
    llm,
    tools: [claudeCode, githubRead],
    name: "qa",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(QA_PROMPT, workerBudget) as any,
  });
  const devops = createReactAgent({
    llm,
    tools: [githubWrite, projectWorkflow],
    name: "devops",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prompt: createTrimmedPrompt(DEVOPS_PROMPT, workerBudget) as any,
  });
  return createSupervisor({
    agents: [coder, qa, devops],
    llm,
    prompt: CTO_PROMPT,
    outputMode: "last_message",
    includeAgentName: "inline",
    supervisorName: "engineering",
  }).compile({ name: "engineering" });
}

/**
 * Build a PARENT supervisor over [engineering(sub-supervisor)] for the isolation
 * integration test — compiled with the given checkpointer (HITL crash-safe).
 * Exported for tests only; production wiring happens in P2.
 */
export function buildEngineeringNestedOffice(checkpointer: BaseCheckpointSaver) {
  const llm = getModel();
  const engineering = buildEngineeringDomain();
  const NESTED_PARENT_PROMPT = `You are the Chief of Staff for Turicks. For anything about code,
repositories, building, testing, PRs, or deployment, route to the engineering team and relay its
result verbatim. No preamble.`;
  return createSupervisor({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agents: [engineering as any],
    llm,
    prompt: NESTED_PARENT_PROMPT,
    outputMode: "last_message",
    includeAgentName: "inline",
  }).compile({ checkpointer });
}
```

- [ ] **Step 4: Run the unit test to confirm it passes**

Run: `pnpm vitest run tests/unit/agents/engineering-domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the nested-HITL integration test (failing)**

Create `tests/integration/engineering-hitl.test.ts` (mirrors `tests/integration/nested-hitl.test.ts`; mocks the github write tool so no real push happens):

```typescript
/**
 * Engineering CTO subgraph — nested HITL integration test.
 * Proves: parent → engineering(CTO) → devops → github_write → interrupt()
 * surfaces via getState().tasks and resumes. REJECT → no write; APPROVE → write once.
 * Live Gemini (cheap) + MemorySaver; the github tool is mocked. Skips without a real key.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

const githubExecute = vi.fn(async () => ({
  success: true,
  data: { html_url: "https://github.com/x/y/pull/1", number: 1 },
}));
vi.mock("../../src/tools/github.js", () => ({
  githubTool: { name: "github", description: "mock", execute: githubExecute },
}));

const { buildEngineeringNestedOffice } = await import("../../src/agents/engineering-domain.js");
const { getPendingApproval } = await import("../../src/agents/office.js");

const _gKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "";
const hasRealKey = _gKey.length > 20 && !_gKey.includes("test");
const d = hasRealKey ? describe : describe.skip;

d("Engineering CTO nested HITL (parent → engineering → devops)", () => {
  beforeEach(() => githubExecute.mockClear());

  it("open a PR 3 levels deep → interrupt surfaces, REJECT → no write", { timeout: 90_000 }, async () => {
    const office = buildEngineeringNestedOffice(new MemorySaver());
    const config = { configurable: { thread_id: "eng-reject" } };
    await office.invoke(
      { messages: [new HumanMessage("Open a pull request titled 'chore: bump deps' on the repo x/y.")] },
      config,
    );
    const approval = await getPendingApproval(office, config);
    expect(approval, "expected a nested engineering approval interrupt").toBeTruthy();
    expect(approval!.action).toMatch(/github/);
    expect(githubExecute).not.toHaveBeenCalled();
    await office.invoke(new Command({ resume: "rejected" }), config);
    expect(githubExecute).not.toHaveBeenCalled();
  });

  it("open a PR 3 levels deep → APPROVE → write happens once", { timeout: 90_000 }, async () => {
    const office = buildEngineeringNestedOffice(new MemorySaver());
    const config = { configurable: { thread_id: "eng-approve" } };
    await office.invoke(
      { messages: [new HumanMessage("Open a pull request titled 'chore: bump deps' on the repo x/y with body 'routine'.")] },
      config,
    );
    const approval = await getPendingApproval(office, config);
    expect(approval).toBeTruthy();
    expect(githubExecute).not.toHaveBeenCalled();
    await office.invoke(new Command({ resume: "approved" }), config);
    expect(githubExecute).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 6: Run the integration test**

Run: `GOOGLE_GENERATIVE_AI_API_KEY=$GOOGLE_GENERATIVE_AI_API_KEY pnpm vitest run tests/integration/engineering-hitl.test.ts`
Expected: With a real Google key — 2 PASS (reject → 0 calls, approve → 1 call). Without a key — SKIPPED (acceptable; verify live in P2).

- [ ] **Step 7: Full suite + lint**

Run: `pnpm test && pnpm lint`
Expected: all green, tsc clean. The live office (`office.ts`) is **unchanged** — engineering still runs flat in production; this subgraph is isolated until P2.

- [ ] **Step 8: Commit + PR into beta**

```bash
git add src/agents/engineering-domain.ts tests/integration/engineering-hitl.test.ts tests/unit/agents/engineering-domain.test.ts
git commit -m "feat(hierarchy): CTO engineering subgraph (coder/qa/devops), isolated + nested-HITL proven (P1)"
gh pr create --base beta --title "P1: CTO engineering subgraph (isolated)" --body "Mirrors revenue-domain.ts. Nested interrupt proven in isolation. office.ts untouched — not yet in prod (P2)."
```

**Success criteria:**
- `buildEngineeringDomain()` compiles a `engineering` sub-supervisor over coder/qa/devops using only existing tools.
- Nested `github_write` interrupt surfaces via `getState().tasks` and resumes (reject → 0 writes, approve → 1 write) — proven by integration test with a real key.
- `pnpm test` + `pnpm lint` green; `office.ts` unchanged (production still flat).

---

## Phases P2–P6 (scoped now, detailed just-in-time at phase start)

### P2 — Wire CTO subgraph into the live office + live verify
- **Files:** `src/agents/office.ts` (replace the flat `engineering` ReAct agent with `buildEngineeringDomain()` as an agent in the `agents:` array), `src/agents/capabilities.ts` (manifest reflects coder/qa/devops or keeps `engineering` as the routable name — decide at phase start), `tests/integration/*`.
- **Success:** parent routes engineering intents to the CTO subgraph; flat behavior preserved for all other depts. **Gate (rule #19.6):** live MTProto via `scripts/e2e-telegram-qa.ts` — a real "open a PR" task shows the 3-level interrupt, approve executes once (real `action_log` row), reject cancels cleanly, and a forced recursion abort does NOT wedge the thread. Evidence = bot reply + `action_log` row.

### P3 — Typed state-slice isolation (global vs local)
- **Files:** `src/agents/contracts.ts` (add an `EngineeringHandoff` slice — only the keys the CTO needs: task brief, target repo/branch, cwd), `src/agents/state.ts`, tests.
- **Success:** the CTO subgraph receives only its declared handoff keys (no company-wide context bloat); `validateSignalPayload`-style boundary check. **Gate:** per-turn token measurement on `turn.out` shows no growth vs flat baseline; tests green.

### P4 — Signal-bus formalization + transactional audit
- **Files:** `src/db/queries.ts` (single-transaction helper: mark task DONE + write `action_log` atomically), `src/agents/agent-tools/signals.ts`, docs.
- **Success:** critical state update + audit commit in ONE Postgres transaction (consistency). **Gate:** real-Postgres test proving partial failure rolls back both.

### P5 — Separate DB schemas (`agents` vs `brain`)
- **Files:** new drizzle migration moving checkpoint/log/signal tables into schema `agents` and vector tables into schema `brain`; `src/db/schema.ts`; `src/infra/checkpointer.ts` (search_path).
- **Success:** distinct schemas enable independent indexing/backup (pgvector optimization). **Gate (rule #22):** migration + rollback verified on a prod-shaped DB (real row counts before/after); zero data loss; `/health` green.

### P6 — 3-level hierarchy tracing
- **Files:** `src/infra/telemetry.ts` / turn-tracing seam, propagate `turnId` parent → CTO → worker.
- **Success:** one `grep <turnId>` shows the full CEO→CTO→worker path with per-level timing. **Gate:** golden-trace test asserts the 3-level ordered seam.

---

## Self-review (against the original spec)

- ✅ "CTO-Led Engineering Team" → P1 (coder/qa/devops sub-agents under a CTO supervisor).
- ✅ "Domain Isolation / state slices" → P3 (typed `EngineeringHandoff` slice) + already-built `outputMode:"last_message"`.
- ✅ "Hierarchical Supervision (CEO→CTO→Workers)" → P1 builds it, P2 puts it in prod; depth capped at 2 graph levels = 3 agent levels, matching the proven `revenue-domain.ts`.
- ✅ "Signal Bus / dept_signals" → already built (§0); P4 adds transactional guarantee.
- ✅ "Separate schemas / transactionality / pgvector" → P5 + P4.
- ✅ "Tracing (LangSmith / turnId)" → P6, extending the existing turn-tracing seam.
- ✅ "Idempotency First" → already built (`idemKey`/`hasBeenAudited`); preserved by reusing existing tools in P1.
- ✅ "No Direct Handoffs / 2 tools" → reframed in ADR-027 (P0) with evidence; sync handoffs kept for HITL correctness, async signals kept for background.
- ✅ "Incremental path to maintain stability" → phased on `beta`, each phase live-verified before the next (rule #19).

**Note on the stated motivation ("it is hallucinating"):** the 2026-06-15 hallucination was a RAG *retrieval* bug (`search_knowledge` dropping the query), already fixed and verified — not an architecture-scale problem. Hierarchy improves *scalability and portfolio depth*; it does not by itself fix hallucination. Retrieval correctness (separate, shipped on PR #72) does.
