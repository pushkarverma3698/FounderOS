# agent-rules.md — binding rules for AI agents (and humans) working on FounderOS

These rules are CI-enforced where possible (`scripts/verify-architecture.ts`)
and review-enforced everywhere else. Violating them is a blocked PR, not a
style nit. Human quick-start lives in [`CONTRIBUTING.md`](CONTRIBUTING.md);
project context in `CLAUDE.md`.

## 1. Architecture (the one orchestration path)

```
message → plan (LLM #1: PlannerDecision — direct reply OR typed Plan)
        → dispatch (PURE CODE supervisor: plan[cursor] → TaskEnvelope)
        → agent ⇄ tools (worker: envelope-only context, capped tools,
                         code-recorded ToolReceipts, HITL interrupt() inside gated tools)
        → collect (pure: StepResult validated against OUTPUT_CONTRACTS)
        → … cursor++ … → synthesize (LLM: validated results only) → reply
```

- There is exactly ONE routing LLM call per turn (the planner). Do not add
  routers, pre-routers, fast-paths, or regex routing — those are tombstoned
  modules and re-creating them FAILS CI.
- `src/gateway/kernel-boot.ts` is the ONLY composition root. The kernel never
  constructs provider clients or reads env — models/tools/checkpointer are
  injected. This is what makes the full graph runnable offline in CI at $0.

## 2. Import direction (CI-enforced)

`contracts ← kernel ← gateway`. The kernel may import only
`kernel/ core/ db/ infra/ tools/`. The gateway never reaches into kernel
internals beyond `src/kernel/index.ts`. New architecture debt is a ratchet
violation — `governance/architecture-baseline.json` may only shrink.

## 3. State management

- All cross-node state lives in `KernelState` (`src/kernel/state.ts`) as
  Annotation channels with explicit reducers. No module-level mutable state,
  no globals, no ambient singletons carrying per-turn data.
- Per-turn channels are reset by the plan node with the `RESET` sentinel.
  Channels that must survive turns (e.g. `history`) say so in a doc comment
  and enforce their own growth bounds (turn cap + char budget) in the reducer.
- Threads persist via the injected checkpointer (PostgresSaver in prod).
  Never wipe a thread in code — only the founder's explicit `/reset` does.
- Immutability everywhere: reducers and nodes return new objects; never
  mutate `state`.

## 4. Contracts & boundaries

- Every boundary payload is a Zod schema in `src/kernel/contracts.ts`
  (PlannerDecision, Plan, TaskEnvelope, StepResult, ToolReceipt,
  FailureReport). Validators are pure and total — they never throw.
- A validation mismatch is a TERMINAL, typed failure. Never retry-and-hope,
  never "make it work" from malformed routing.
- Known LLM drift is repaired IN CODE via deterministic preprocess
  (rule #16): kind-echo → `kindFromSchemaRef`; unknown data refs →
  `data.generic`. Content is never invented; `draft.*` and `action_receipt`
  contracts are NEVER weakened — they feed HITL previews and the receipt gate.
- New output shapes get a new entry in `OUTPUT_CONTRACTS` + parity test.
  Never widen an existing schema to make a failing payload pass.

## 5. Asynchronous error handling

- Every failure is a `FailureReport`: stage + component + message + evidence
  + retryable. Name the REAL failing component ("openrouter",
  "postgres/pgvector"), not a generic wrapper.
- Provider errors classify by HTTP status class (`src/agents/model.ts`):
  5xx/429/transport → retriable; 404 → model fallback; 401/403 → fail LOUD.
- No silent catches. A fail-open catch requires an
  `// allow-failopen: <reason>` tag or CI fails.
- The founder always sees failures verbatim. Never convert an error into a
  cheerful non-answer.

## 6. Tools & side effects (API routing)

- Tools are `UnifiedTool` implementations (`src/tools/`) returning the
  `ToolResult` envelope; workers get them wrapped via `src/agents/agent-tools/`.
- `src/kernel/tool-adapter.ts` pins the ordering — do not reorder:
  1. HITL DB row BEFORE `interrupt()`;
  2. side effects only after approval;
  3. idempotency-key check before EVERY external send;
  4. audit row only on real success.
- ToolReceipts are recorded by CODE, never claimed by the model. An
  `action_receipt` step without a successful receipt fails validation.

## 7. Determinism

- temp 0 everywhere. Routing, parsing, and guards are pure unit-tested
  functions — never prompt instructions.
- CI runs the golden set twice; plans must be identical. Anything
  nondeterministic in the plan path is a bug.

## 8. Testing & cost discipline

- `pnpm test` is $0: scripted models only. A real LLM/API call inside a unit
  test is a bug, full stop.
- Bug fixes START with a failing test that reproduces the live trace.
- `pnpm gate` (lint+build+wiring+arch+test) must be green before any PR.
- Paid gates run ONCE per milestone: `pnpm eval` (golden set),
  `pnpm qa:telegram` (MTProto acceptance). Never iterate against them.

## 9. Code shape

- No src file over 400 lines (CI). Many small files > few large files.
- Surgical changes only: don't "improve" adjacent code, don't refactor what
  isn't broken, match existing style. Every changed line traces to the task.
- No TODO comments — implement fully or raise the gap explicitly.
- Comments state constraints the code can't show (the WHY), with the live
  trace/date when repairing drift.

## 10. Evidence over assertion (rule #24)

"Done" = the verification command run fresh in the same session with output
shown. Unit tests are necessary, not sufficient — exercise the real path
(gateway → kernel → tool → reply → action_log row) before claiming anything
works. Unverifiable ⇒ say **NOT VERIFIED — <reason>**.

## 11. Git & delivery

- Never commit to `main`. Flow: work branch → PR to `beta` → `main`
  (founder merges only; CI-enforced).
- Conventional commits. Evidence (fresh gate output + live-path proof or an
  explicit NOT VERIFIED) in every PR body.
- Docs/ADR changes → `pnpm brain:sync`; significant decisions → episodic
  memory. Memory is the source of truth.
