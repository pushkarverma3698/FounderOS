# ADR-017 — Bounded Conversation History (the permanent loop fix)

**Status:** Accepted
**Date:** 2026-06-04
**Related:** ADR-010 (v2 ReAct rebuild), checkpointer.ts:70-78

---

## Context

FounderOS uses a stable LangGraph thread_id per Telegram chat (`turicks:{chatId}`) so
conversation memory survives across messages. The Postgres checkpointer therefore
accumulates the **entire** message history forever. Symptom reported by the founder:
*"it loops — gives the same reply to every question and can't do real tasks."*

A live probe (`scripts/probe-real-task.ts`) proved the office logic is sound: on a **fresh**
thread, every real task works (file listing, web search, follow-up recall). The failure was
**state pollution** — old turns replayed every message, anchoring the supervisor on stale
state (e.g. a prior HITL "Yes" context, or a stale refusal). The per-call prompt trimmer
(`context-manager.ts`) caps the *model input* per call but never removes messages from the
checkpointer, so the persisted thread grows without bound. The only mitigation was the manual
`/reset` command — not acceptable for daily use.

## Decision

**Bound the persisted history to the last N human turns, automatically, after every clean turn.**

- `src/infra/history-window.ts` `computeHistoryTrim(messages, {keepTurns})` — a PURE function
  that returns the message ids to delete. The kept window always begins on a HumanMessage, so we
  never strand an orphaned leading tool message (Gemini rejects that ordering).
- `trimThreadHistory()` (gateway) applies the removals via `RemoveMessage` + `updateState` after
  a clean turn. **Guard: never trim while an approval is pending** — `updateState` would clobber
  the paused interrupt (ADR-004/HITL). Fire-and-forget + `.catch()` → never blocks or crashes a reply.
- `HISTORY_KEEP_TURNS` env (default 12 turns ≈ 2.4k tokens, well inside the 6k supervisor budget,
  enough for multi-turn follow-ups like "attach it" / "show me the content").

Also decided, same change:
- **Recursion limit** on every `invoke` (`OFFICE_RECURSION_LIMIT`, default 20) and an explicit
  `GraphRecursionError` catch → friendly message instead of a runaway loop or raw stack trace.

### Alternatives rejected
- **Hard count cap + `clearThreadCheckpoints`** — wipes all context, breaks mid-HITL sequences.
- **Per-turn ephemeral threads** — would break HITL resume (callback reconstructs the thread from
  chatId) and lose follow-up context; multi-file change.
- **Keep per-call trim only** — does not bound the persisted thread; delays the problem.

## Consequences
- **Positive:** the looping class of bug is eliminated; threads stay small and cheap; `/reset`
  becomes optional. Runtime-verified: 30 → 24 messages, kept window starts on a human message.
- **Cost:** one extra `updateState` (fire-and-forget) per clean turn; a rare benign race between
  the async trim and the next `getState` (self-corrects — `finalReply` still returns the current
  turn's answer).
- **Determinism preserved:** temperature stays 0 (rule #16); the trim is a pure function with unit
  tests, not a prompt instruction.

## Verification
405 tests green · tsc clean · multi-turn live probe: distinct correct answers, real tool use,
follow-up recall, no looping. See PR #28 and CLAUDE.md rule #19 (test the real gateway path).
