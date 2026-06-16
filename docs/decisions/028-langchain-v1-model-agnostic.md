# ADR-028: LangChain v1 model-agnostic office

Date: 2026-06-16

## Status

Accepted.

## Context

FounderOS was unstable when provider packages moved or Gemini credits ran out. The
root cause was not the supervisor graph: the office remains a standard LangGraph
supervisor with seven focused tool departments, compiled once, and pinned to
`outputMode: "last_message"`.

The failure lived in the custom model layer. `src/agents/model.ts` reimplemented
tool binding, retry, fallback, OpenRouter failover, Gemini sanitization, and
synthetic recovery responses inside one `BaseChatModel` subclass. That coupled the
app to undocumented LangChain internals and let the system invent successful output
when the model returned empty candidates.

## Decision

Use LangChain v1 packages with exact pins and return plain provider chat models:

- `openrouter:openai/gpt-4o-mini` is the default while Gemini credits are depleted.
- `google-genai:...`, `openai:...`, `anthropic:...`, and `openrouter:...` model IDs
  are selected by `AGENT_MODEL`.
- `AGENT_FALLBACK_MODELS` is a comma-separated list of provider-prefixed fallbacks
  wired through LangChain's `modelFallbackMiddleware`.
- Departments use `createAgent(...).graph` from `langchain`.
- The top-level supervisor stays on `createSupervisor` from
  `@langchain/langgraph-supervisor`, with `outputMode: "last_message"` unchanged.
- Rolling-window trimming moved into LangChain v1 middleware for departments; the
  supervisor keeps its supported `prompt` hook.

## Consequences

- No custom `bindTools`, `_generate`, streaming, fallback, or Gemini adapter code.
- Empty model output now fails through the provider/middleware path; FounderOS no
  longer fabricates "Action completed" or tool-result success messages.
- Provider changes are env-only.
- Production env validation now checks the API key that matches the selected
  provider instead of assuming Gemini.

## Verification notes

Phase-0 live MTProto verification is still required before claiming full production
recovery: route, tool call, HITL approve/reject, and matching `action_log` rows must
be proven with real provider keys. This ADR records the architectural migration, not
the final production acceptance run.
