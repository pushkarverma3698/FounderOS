# FounderOS — Programming Rules & Wiring Maps

> **Read this before adding ANYTHING to the codebase.**
>
> This document exists because the most common bug in this project is NOT logic —
> it's **half-wiring**: you add code in one file, forget the second file it must
> also touch, and get a silent failure (wrong route, dead tool, eval mismatch).
>
> Each section below is a **wiring map**: the exact files to touch, in order,
> plus a "if you forget this → you get this error" table.

---

## The 8 Iron Rules (apply to everything)

1. **TDD always** — no production code without a failing test first (RED → GREEN → REFACTOR).
2. **HITL before every external action** — any send/post/push/create/delete calls `hitlGate()` and runs the side-effect ONLY after approval.
3. **Idempotency before every send** — `hasBeenAudited()` before, `writeAuditEntry()` only after a confirmed success id.
4. **Soft-failure detection** — external APIs return HTTP 200 + error message with no id. Check for the id; return `success: false` if missing. (See `TESTING-RULES.md` Rule 2.)
5. **Determinism** — model temperature stays 0; push logic into pure functions with unit tests, not prompt instructions.
6. **LangChain ChatResult shape** — `ChatResult.generations` is `ChatGeneration[]` (single-nested, NOT double-nested). Any function that synthesizes or mocks a `ChatResult` (e.g. `syntheticResponseFromLastTool`) MUST return `generations: [{ text, message, generationInfo }]`. Double-nesting causes `generation.message` to be `undefined` → crash inside `_generateUncached`. Tests: assert `result.generations[0].text`, NOT `result.generations[0][0].text`.
7. **Zod optional fields always include `.nullable()`** — `z.string().optional()` alone triggers a LangChain SDK deprecation warning that will become a hard error in a future SDK version. Every optional tool schema field MUST be `z.string().optional().nullable()`. If the downstream function signature is `T | undefined` (not `T | null | undefined`), coerce at call-site: `field ?? undefined`.
8. **Regression test before every commit** — before staging any file, run `pnpm test`. If any test changes to match new code behaviour, first confirm the *test* is correct before updating it. Never update a test to fix a red suite without understanding why the original test was right.

---

## Wiring Map 1 — Add a Tool

A tool is only "integrated" when **all 6 layers** are wired. Miss one → silent failure.

| # | Layer | File | What you add |
|---|-------|------|-------------|
| 1 | **Tool body** | `src/tools/{name}.ts` | `UnifiedTool` impl — the external call + error handling. Never throws. |
| 2 | **Unit test** | `tests/unit/tools/{name}.test.ts` | Mock Composio/HTTP. Test happy + soft-fail + thrown (TESTING-RULES Rule 6). |
| 3 | **Agent wrapper** | `src/agents/agent-tools/{dept}.ts` | LangChain `tool()` + `hitlGate()` if it writes. Export it. |
| 4 | **Barrel** | `src/agents/agent-tools.ts` | Add the new tool to the `export { ... }` line for its dept module. |
| 5 | **Department** | `src/agents/office.ts` | Add the tool to the right department's `tools: [...]` array. |
| 6 | **Prompt** | `src/agents/system-prompts.ts` | Tell the dept agent it has the tool (dept prompt) AND add the trigger to the SUPERVISOR routing table. |

**Optional 7th layer:** `src/mcp/server.ts` — only if the tool is **read-only** and worth exposing to Claude Code / Cursor. Add to `FOUNDEROS_MCP_TOOLS` + the switch in `executeMcpTool`.

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| Layer 2 (test) | The field-name bug class — wrong Composio params ship to production (calendar `start.dateTime` bug). |
| Layer 3 (wrapper) | Tool exists but agents can't call it — it's not a LangChain tool. |
| Layer 4 (barrel) | `office.ts` import fails: `'X' has no exported member`. tsc error (loud — good). |
| Layer 5 (department) | Tool is built but no agent has it — dead code, never invoked. |
| Layer 6 dept prompt | Agent has the tool but never uses it ("I can't do that") — the silent bug. |
| Layer 6 routing | Supervisor never routes the trigger phrase to that dept — request goes elsewhere. |

### Order to work in

1. Verify the external contract live FIRST (probe script) — get the real action slug + field names.
2. Write the test (RED) → tool body (GREEN) → wrapper → barrel → department → prompts.
3. `pnpm test` + `pnpm lint` green → restart bot → verify on a **clean thread** (`/reset`).

---

## Wiring Map 2 — Add a Department

The widest blast radius: **10 files**. This is the one that bites hardest.

| # | File | What you add |
|---|------|-------------|
| 1 | `src/agents/system-prompts.ts` | New `{NAME}_PROMPT` export. |
| 2 | `src/agents/system-prompts.ts` | Add a row to the SUPERVISOR routing table + a routing shortcut. |
| 3 | `src/agents/system-prompts.ts` | Add the dept's tools to the TOOL OWNERSHIP block. |
| 4 | `src/agents/office.ts` | `createReactAgent({ ... name: "{name}" })` block. |
| 5 | `src/agents/office.ts` | Add the agent to the `createSupervisor({ agents: [...] })` array. |
| 6 | `src/agents/office.ts` | Add the name to the `log.info("Office compiled...")` line. |
| 7 | `src/eval/types.ts` | Add `"{name}"` to the `Department` union type. |
| 8 | `src/eval/office-invoker.ts` | Add `"{name}"` to the `DEPARTMENTS` Set. |
| 9 | `src/eval/golden-tasks.ts` | Add at least one golden task that routes to the new dept. |
| 10 | `src/gateway/commands.ts` | Add `"{name}"` to the `/q` valid-depts list + the `/departments` help text. |

**Also update (low-risk but do it):** `src/index.ts` startup banner dept list.

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| #2 routing table | Supervisor never routes there — the dept is dead code. |
| #5 agents array | `createReactAgent` built but not in the graph — runtime: agent unknown. |
| #7 Department type | tsc error in eval (loud — good). |
| #8 DEPARTMENTS Set | Eval routes to `null`; every golden task for the dept fails silently. |
| #10 /q list | `/q {name}` returns "unknown department" to the founder. |

> **This is exactly the bug class you hit.** The 8→7 department change touched all
> 10 of these. Missing #8 (`office-invoker.ts`) would have made eval silently wrong.

---

## Wiring Map 3 — Add a Workflow (SOP)

The simplest — **3 touch points**.

| # | File | What you add |
|---|------|-------------|
| 1 | `src/workflows/registry.ts` | A `WorkflowDef` object in the `WORKFLOWS` array (id, name, params, steps). |
| 2 | `tests/unit/workflows/registry.test.ts` | A test asserting `getWorkflow("{id}")` returns it + params parse. |
| 3 | `MEMORY.md` | One line documenting the new workflow + its params. |

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| #1 steps array | `/run {id}` says "unknown workflow". |
| Param mismatch | `/run {id} company=X` fails validation if the step template uses a different `{slot}` name. |

> Workflows need NO new tools or routing — each step is a natural-language task
> routed through the existing office. That's the whole point of the design.

---

## Wiring Map 4 — Add a Telegram Command

**4 touch points** across 2 files.

| # | File | What you add |
|---|------|-------------|
| 1 | `src/gateway/commands.ts` | `export async function handle{Name}(ctx, ...) { ... }` |
| 2 | `src/gateway/telegram.ts` | Import `handle{Name}` in the commands import block. |
| 3 | `src/gateway/telegram.ts` | `bot.command("{name}", (ctx) => handle{Name}(ctx, ...))` registration. |
| 4 | `src/gateway/commands.ts` | Add the command to `handleCommands` help text. |

### Forget → Error table

| If you forget… | You get… |
|----------------|----------|
| #2 import | tsc error (loud — good). |
| #3 registration | Command does nothing — Telegram ignores `/{name}`. |
| #4 help text | Command works but is undiscoverable (`/commands` doesn't list it). |

---

## Path & Import Rules (project-wide)

- **ES modules** — every import uses a `.js` extension even for `.ts` files:
  `import { x } from "./module.js"`.
- **Relative depth** — files in `src/agents/agent-tools/` reach `src/tools/` via
  `../../tools/` (up two levels). A wrong depth is a tsc error (loud).
- **No circular imports** — dependency direction:
  `core → db → infra → tools → agents → gateway`. Never import "up" the chain.
- **Env access** — `process.env["KEY"]` (bracket notation), validated in `core/config.ts`.
- **Bracket env in config only** — everywhere else, import the validated `env` or `TENANT` from `core/config.ts`.

---

## File Size Rules

- 200–400 lines typical, **800 max**. When a file passes ~600, split it by concern.
- `agent-tools.ts` was split at 660 lines into `agent-tools/{dept}.ts` modules +
  a barrel. Follow that pattern: one module per department, a barrel that re-exports.

---

## The Verification Ritual (after ANY change)

```bash
pnpm lint          # tsc — must be clean
pnpm test          # full suite — must be green
pnpm eval          # only if routing/tools/prompts changed — golden set must hold
# restart bot, then verify the REAL path on a clean thread:
/reset             # in Telegram — clears sticky checkpoint history
# ...exercise the actual change...
```

A green suite is necessary, not sufficient. The worst bugs passed the unit
tests while failing in production because the test never touched the real
gateway path. **Verify live on a clean thread.** (See CLAUDE.md rule #19.)

---

## Cross-References

- **Tool quality bar** → `TOOL-STANDARDS.md` (8-point checklist)
- **Test quality bar** → `TESTING-RULES.md` (8 rules + template)
- **External API integration** → `TOOL-INTEGRATION-PLAYBOOK.md` (Composio contract verification)
- **System design** → `../guides/ARCHITECTURE.md`
- **Running it** → `../guides/OPERATIONS.md`
