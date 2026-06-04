# ADR-016 — Memory: FounderOS as the Single Source of Truth

**Status:** Accepted
**Date:** 2026-06-04
**Supersedes / extends:** the design spec `docs/superpowers/specs/2026-06-04-memory-system-design.md`

---

## Context

FounderOS started with no recall. Each Telegram session began cold, and any knowledge produced
while working *with the assistant* (Claude) lived only in chat history — ephemeral, unqueryable, and
lost to the next session. Meanwhile two durable knowledge stores already existed but drifted:

| Store | Holds | Drift problem |
|---|---|---|
| `turicks-brain` (`knowledge_entries`) | ADRs, brand, phase/study docs | only updated on manual `brain:sync` |
| `personal-rag` (ChromaDB) | CV / career / portfolio docs | only updated on manual ingest |
| LangGraph `checkpoints` | per-thread graph state | opaque, not queryable by agents |
| `founder_context` (JSONB) | 21 business keys | manual |

The founder's directive: *"Everything I do with the assistant must also be done with FounderOS, so
it becomes the single source of truth for personal-rag and turicks-brain."*

## Decision

**FounderOS is the single source of truth. Memory must be kept current as a standing rule, not an
afterthought.** Three Postgres-first tiers, plus the two RAG stores, are updated at the end of any
session that changes state.

### Tiers (Postgres-first, deterministic)
1. **Episodic** — `episodic_memory` (event_type, title, summary, tags, occurred_at).
2. **Conversation log** — `conversations` (thread_id, summary, topics, message_count), auto-recorded
   after each Telegram conversation by `src/infra/conversation-recorder.ts`.
3. **Knowledge base** — `knowledge_entries` (turicks-brain, synced via `pnpm brain:sync`) +
   `founder_context`.

### Why Postgres before vector
Keyword + recency search is deterministic at temperature 0 (CLAUDE.md rule #16), reuses existing
Drizzle/Postgres infra, and is human-inspectable with SQL. Semantic/pgvector RAG is a later phase —
adding it before basic recall works would be premature (rule #17).

### The standing rule (CLAUDE.md #18)
Every working session, decision, and capability change is written back into the memory tiers:
`brain:sync` for docs, `record_event`/recorder for episodic+conversation, the portfolio brief
re-ingest for personal-rag, and `MEMORY.md` for the fast index.

## Boundary (non-negotiable)

`personal-rag` and `turicks-brain` are **separate stores and never cross-write** (ADR-013, ADR-015).
- `turicks-brain` ← business + portfolio docs (the build itself, ADRs, strategy).
- `personal-rag` ← career/CV/personal knowledge, including a read-only **FounderOS portfolio brief**
  so the job-hunt department can answer "what is my strongest project?" — but personal-rag is never
  written to turicks-brain and is never auto-submitted into forms.

## Consequences

- **Positive:** "what did we decide about X?" becomes answerable; the next session starts warm;
  portfolio/career context stays current for the job hunt; one engine, many stores.
- **Cost:** discipline — the sync steps must run at session end. Mitigated by making them one command
  each and codifying them as rule #18.
- **Follow-up (deferred):** MCP manager layer that routes `search_memory` across tiers + personal-rag
  over HTTP (Phase 2 of the memory spec); pgvector hybrid search for semantic recall (F2).

## See also
- `docs/superpowers/specs/2026-06-04-memory-system-design.md` — full design
- ADR-013 (keep personal/engineering separate), ADR-015 (jobhunt + personal-rag boundary)
- `src/tools/memory.ts`, `src/infra/conversation-recorder.ts`, `scripts/sync-turicks-brain.ts`
