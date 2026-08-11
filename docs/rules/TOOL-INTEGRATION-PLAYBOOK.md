# FounderOS — Tool & Feature Integration Playbook

> **Read this before integrating ANY tool or adding ANY feature.**
> It exists because two "simple" integrations (email reading, Composio actions)
> each shipped multiple avoidable bugs. The bugs were not in the tool code —
> they were in the *wiring around it*. This playbook makes the wiring a
> checklist, not a guessing game.

---

## Why this exists — the three bug classes we keep hitting

| # | Bug we shipped | Root cause | The rule it creates |
|---|----------------|-----------|---------------------|
| 1 | Bot said "I can't read emails" while the tool was wired in | The **prompt** never told the agent the tool existed | **Wiring ≠ awareness.** A tool is only "integrated" when the prompt + routing know it. |
| 2 | `GMAIL_LIST_EMAILS` / `LINKEDIN_CREATE_SHARE_POST` 404'd | We **assumed** the external action name/params | **Verify the contract against the live API**, never assume. |
| 3 | "still cannot…" after the fix | Stale **thread checkpoint history** replayed old refusals | **State is sticky.** Behaviour changes need a clean thread to verify. |

Every step below maps to preventing one of these.

---

## The Iron Rules (non-negotiable)

1. **TDD always.** No production code without a failing test first (RED → GREEN → REFACTOR). See `superpowers:test-driven-development`. This is already mandated in CLAUDE.md §11.
2. **A tool is not "done" until it is wired in all FIVE layers** (see checklist).
3. **Verify the external contract live** before writing the tool body. Discover the real action slug + response shape; don't trust memory or docs alone.
4. **Read-only by default; writes are HITL-gated.** Any tool that sends/posts/pushes/deletes calls `interrupt()` and executes the side-effect only AFTER approval.
5. **Surface failures, never swallow them.** Tools return error strings (they don't throw); the gateway must show them to the founder.
6. **Verify on a clean thread.** Behaviour/prompt changes are confirmed only after `/reset` (or a fresh chat), because the checkpointer replays history.

---

## The 5 Integration Layers — a tool is only "integrated" when all are done

A tool touches five files. Miss one and you get a silent failure.

```
1. TOOL BODY      src/tools/<name>.ts          — the actual call + error handling
2. AGENT WRAPPER  src/agents/agent-tools.ts    — LangChain tool() + interrupt() if write
3. DEPARTMENT     src/agents/capabilities.ts   — added to DEPARTMENT_TOOLS[dept]
4. PROMPT         src/agents/prompts/<dept>.ts — the agent is TOLD it has the tool + when to use it
5. ROUTING        src/kernel/planner.ts        — buildPlannerPrompt names the worker that owns it
```

> **Bug #1 was a missing Layer 4 + 5.** The tool existed at layers 1–3 but no
> prompt mentioned it, so the LLM refused. Layers 4 and 5 are where most
> "integrated but doesn't work" bugs live.

---

## Step-by-step workflow

### Phase 0 — Verify the external contract (prevents bug class #2)
For any third-party tool (Composio, an API):
1. Discover the **real** action slug and parameter schema from the live provider, e.g.:
   ```ts
   // Composio: list real actions + schemas, don't guess the slug
   client.tools.list({ search: "gmail", limit: 100 })
   ```
2. Record the exact **action slug**, **request params**, and **response field names** in the tool file's header comment.
3. Confirm the connection exists and is ACTIVE (see `src/infra/composio.ts` connection IDs).

### Phase 1 — RED: write the failing test first (prevents bug class regressions)
- Unit-test the tool body with the provider **mocked** using its REAL response field names (not guessed ones — that's how the email-reader test caught a field-name bug).
- Cover: success, empty result, provider error, missing API key, default args.
- Run it. Watch it fail for the right reason.

### Phase 2 — GREEN: implement the tool body (Layer 1)
- `src/tools/<name>.ts` implementing `UnifiedTool` → `{ success, data?, error? }`.
- **Return** errors as `{ success:false, error }`; never `throw` past the tool boundary.
- Read-only tools: no approval. Write tools: the side-effect lives in the **agent wrapper** after `interrupt()`, NOT here.

### Phase 3 — Wire Layers 2–5
- **Layer 2** `agent-tools.ts`: wrap with `tool()`. If it writes, call `interrupt()` first; put the real call AFTER the approval check (it re-runs — keep pre-interrupt code pure).
- **Layer 3** `capabilities.ts`: add to the correct entry of `DEPARTMENT_TOOLS`.
- **Layer 4** the department `*_PROMPT`: list the tool, when to use it, and how to format its output.
- **Layer 5** `buildPlannerPrompt` (`src/kernel/planner.ts`): the planner sees each worker's tool
  names from the catalog, so a tool wired at Layer 3 is already routable. Add a prompt rule only
  when the trigger phrase is ambiguous between two workers — `pnpm verify:wiring` warns when a
  department carries a tool its prompt never mentions.

### Phase 4 — Verify end-to-end on a CLEAN thread (prevents bug class #3)
1. `pnpm test` green + `npx tsc --noEmit` clean.
2. Restart the bot from the merged code.
3. **`/reset`** the test chat (clears poisoned history) BEFORE testing the new behaviour.
4. Send the real trigger phrase. Read `/tmp/founderos.log`:
   - `toolErrors: 0` **and** the tool's own log line present → tool ran, success.
   - `toolErrors: 0` and NO tool log line → the LLM never called it → **Layer 4/5 problem** (prompt/routing).
   - `toolErrors: 1` → tool ran and failed → **Layer 0/1 problem** (contract/impl).

> **The `toolErrors` signal is your fastest diagnostic.** 0-with-no-tool-call vs
> 1 tells you instantly whether the bug is in the prompt or the implementation.

### Phase 5 — Ship
- Feature branch (`feat/<name>` or `fix/<name>`), PR, human merges. Never commit to `main`.
- Update `MEMORY.md` (status + any new gotcha) and this playbook if a new failure mode appeared.

---

## Tool integration checklist (copy into the PR description)

```
Contract
- [ ] Real action slug + params + response fields verified against the live provider
- [ ] Connection ACTIVE; IDs recorded in composio.ts
Test-first
- [ ] RED unit test written + watched fail (mocks use REAL response field names)
- [ ] Cases: success / empty / provider-error / missing-key / default-args
Five layers
- [ ] L1 tool body returns {success,error}, never throws past boundary
- [ ] L2 agent wrapper (interrupt() BEFORE side-effect if it writes)
- [ ] L3 added to the correct DEPARTMENT_TOOLS entry in capabilities.ts
- [ ] L4 department prompt (src/agents/prompts/<dept>.ts): tool listed + when-to-use + output formatting
- [ ] L5 planner: usually a no-op (catalog-driven) — add a buildPlannerPrompt rule only if the trigger is ambiguous between two workers
Verify
- [ ] pnpm test green + tsc clean
- [ ] Live: /reset → trigger phrase → correct toolErrors signal in logs
Ship
- [ ] Feature branch + PR, MEMORY.md updated
```

---

## Industry-standard guardrails (so this codebase never becomes the old 17k-LOC one)

The v1 codebase grew to ~17k LOC and was deleted. These rules keep v2 lean:

- **Thin tools, fat prompts.** Behaviour lives in prompts (cheap to change), not in bespoke orchestration code. Adding a capability should be ~1 tool + prompt edits, not a new subsystem.
- **One way to do a thing.** Registry-driven config, one graph compiled once, one query layer (`db/queries.ts`), one LLM accessor (`getModel`). No parallel mechanisms.
- **Pure functions are the testable core.** Extract logic (formatting, parsing, scoring) into pure functions with unit tests; keep I/O at the edges. This is why `format.ts`, `status.ts`, `context-command.ts` are separate, tested modules.
- **Boundary validation with Zod.** Validate env + external API responses; never `as any` raw provider data.
- **Idempotency before every external write.** SHA1 key + `audit_log` so retries never double-send.
- **Observability from day one.** Structured pino logs + LangSmith; every external action logs a line. If you can't see it in the logs, you can't debug it.
- **Delete aggressively.** Dead code is a liability. If a feature is superseded, remove it in the same PR — don't leave it "just in case" (that's how v1 hit 17k LOC).
- **Cost awareness.** Prefer the cheapest model that works; route deterministically where possible (a regex beats an LLM call). Don't add an LLM hop you can avoid.
- **Every architectural decision gets an ADR** in `docs/decisions/` and is synced to turicks-brain.

---

## Related
- TDD discipline: `superpowers:test-driven-development`
- Debugging discipline: `superpowers:systematic-debugging` (find root cause before fixing)
- Dropped-v1-feature backlog: `docs/study/V1-FEATURE-INVENTORY.md`
- Project rules: `/CLAUDE.md` (esp. §§11–15)
