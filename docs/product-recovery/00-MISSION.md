# FounderOS Product Convergence — Mission

**Status:** Audit complete 2026-08-08. Plan is the contract. No implementation performed this session.
**Audited against:** prod VPS `f7ea923` (= `origin/main`), live journalctl, live Postgres `agents` schema.

---

## The one-line diagnosis

FounderOS's execution substrate is sound and its autonomous lanes run on schedule — but the
flagship lane has produced **2 job applications in its entire lifetime**, and when the founder
asks it a direct question about its own data it answers with a fabricated partial result and the
words **"Mission complete."**

The binding constraint is **not** context overload. It is that **no capability owns a founder
objective end to end**, and **nothing checks whether the objective happened.**

## What this program is

A 12-phase transition from *an agent platform that runs* to *an assistant that finishes*.
Ordered by **evidence and leverage**, not by architectural tidiness.

Phases 1–4 restore outcomes. Phases 5–8 remove the complexity that makes outcomes unreliable.
Phases 9–12 make reliability measurable and self-compounding.

## Non-negotiables for every implementing session

1. **Runtime evidence outranks docs.** This repo's docs describe a system more finished than the
   one running. Trace it, don't trust it.
2. **No new capabilities.** No new agent, router, memory system, RAG layer, browser
   implementation, or workflow framework. Every phase either deletes or connects.
3. **"Tool succeeded" ≠ "objective succeeded."** A phase ships when a founder-language request
   produces the real artifact, verified.
4. **One implementer, one validator.** Sonnet implements the phase contract. Antigravity
   validates the founder experience. Neither redesigns the architecture.

## Reading order

| Doc | Purpose |
|---|---|
| `01-THESIS-AND-REALITY.md` | What the strategy docs got right, and the **three claims that are false** |
| `02-SYSTEM-AUDIT.md` | Measured inventory: LOC, tools, prompts, dead code |
| `03-CAPABILITY-MAP.md` | Every capability, its canonical path, and where the path stops |
| `04-DUPLICATION-AUDIT.md` | Real duplication vs. imagined duplication |
| `05-INSTRUCTION-AUDIT.md` | 1,342 lines of root instructions, classified |
| `06-CONTEXT-RAG-MEMORY.md` | What actually enters the model context per turn |
| `07-HERMES-SKILLS-TOOLS.md` | **What Hermes actually is in this repo** (not what the thesis assumed) |
| `08-EXECUTION-AUDIT.md` | The CSV turn, traced line by line from prod logs |
| `09-VERIFICATION-RECOVERY.md` | 1 verifier for 8 workers |
| `10-REALITY-BENCHMARK.md` | The 30-task founder benchmark that replaces routing accuracy |
| **`11-12-PHASE-TRANSITION.md`** | **The roadmap. This is the contract.** |
| `12-FAILURE-LEDGER.md` | Every defect found, with evidence, unfixed by design |
| `13-HANDOFF-PROTOCOL.md` | What each implementing session may and may not load |

## What "done" looks like for the whole program

The founder types a sentence. FounderOS answers with the real number, attaches the real file,
and — when it cannot — says exactly which step stopped and why. Ignoring its output costs him
something visible.
