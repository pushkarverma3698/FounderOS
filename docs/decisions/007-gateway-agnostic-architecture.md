# ADR-007: Gateway-Agnostic Architecture

**Date**: 2026-06-01
**Status**: Accepted

## Context

FounderOS currently uses Telegram as its only gateway. The plan is to move to a custom web app for the SaaS phase. Both gateways must be able to run simultaneously against the same FounderOS graph without duplicating business logic.

## Decision

All business logic lives in agent pods (`src/agents/pods/`). Gateways are pure transport layers — they receive input, call the graph, and return output. No routing logic, no prompt construction, no state management in any gateway.

```
Gateway (Telegram | Web App | CLI)
    ↓ parse input → AgentInput shape
FounderGraph (compiled once, shared)
    ↓ return output → display format
Gateway (format + send response)
```

## Gateway Contracts

Every gateway must:
1. Parse input into the standard `AgentInput` type (defined in `src/agents/state.ts`)
2. Call `getGraph().invoke(input, config)` — never compile the graph inside a handler
3. Format the returned state for its transport (Telegram message vs JSON response vs CLI output)
4. Handle errors at the transport level (retry, fallback message)

## Current Gateways

| Gateway | File | Status |
|---|---|---|
| Telegram | `src/gateway/telegram.ts` | Active — personal ops |
| Web App | (future Next.js project) | Planned — SaaS-facing |

## Consequences

- New gateways can be added without touching agent pods
- Telegram stays live for personal ops while web app serves SaaS users simultaneously
- All prompts, routing, and state transitions remain in pods → fully testable without a gateway
- Web app needs its own auth layer (Google OAuth) while Telegram uses the existing bot token
