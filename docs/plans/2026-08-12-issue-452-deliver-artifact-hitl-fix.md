# Plan: Fix HITL Pause Signal Swallowing in deliverArtifact (Issue #452)

## Problem Statement
`deliverArtifact` in `src/agents/agent-tools/state.ts` wrapped its `hitlGate(...)` call inside a `try { ... } catch (err) { ... }` block. `hitlGate` delegates to LangGraph's `interrupt()`, which throws an exception to interrupt/pause the execution graph for human-in-the-loop approval. Because `hitlGate` sat inside the `try` block, that interrupt exception was caught by `state.ts`'s own `catch (err)` and converted into a generic string error message (`❌ Failed to deliver artifact: ...`), preventing the HITL approval card from being triggered in Telegram.

## Solution Architecture
1. Move `hitlGate` outside the `try { ... } catch` block in `deliverArtifact` (`src/agents/agent-tools/state.ts`), matching the established pattern in `comms.ts`, `engineering.ts`, `personal.ts`, `scheduling.ts`, `vps-run.ts`, and `external-mcp.ts`.
2. Keep the `try { ... } catch` block around `deliverArtifactFile` so genuine delivery errors (e.g. file read errors, Telegram API failures) are still caught and handled cleanly post-approval.

## Implementation Steps
1. Create a unit test `tests/unit/agents/state-deliver-artifact.test.ts` asserting:
   - When `hitlGate` throws an interrupt error, `deliverArtifact` allows the error to throw (does NOT catch it).
   - When `hitlGate` returns a rejection string, `deliverArtifact` returns the rejection string.
   - When `hitlGate` returns `null` (approval) and `deliverArtifactFile` succeeds, `deliverArtifact` returns the success message.
   - When `hitlGate` returns `null` (approval) and `deliverArtifactFile` throws an error, `deliverArtifact` catches the side-effect error and returns the formatted error string.
2. Run the unit test to watch the interrupt propagation test fail on current code.
3. Update `src/agents/agent-tools/state.ts` to execute `hitlGate` outside the `try/catch` block.
4. Re-run tests to confirm all tests pass.
5. Run full gate checks (`pnpm gate`, `pnpm predeploy`).
6. Run `pnpm brain:sync` to sync `docs/`.
7. Create draft PR targeting `beta`.
