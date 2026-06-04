# FounderOS Memory System — Design Spec
_Date: 2026-06-04 | Status: Implementing_

## Problem

FounderOS has no recall. Every Telegram session starts cold:
- "What did we discuss Tuesday?" → no answer
- "What was the status of the Stripe client?" → no answer
- The system can't learn from usage patterns or accumulate business context over time

Current state:
| Store | What it holds | Limitation |
|---|---|---|
| LangGraph `checkpoints` | Full conversation graph state per thread | Opaque, not queryable by agents |
| `founder_context` (JSONB) | 21 manually-seeded business keys | Requires manual update, no history |
| `knowledge_entries` | 32 turicks-brain docs (keyword search) | Requires manual `brain:sync` |
| personal-rag ChromaDB | CV + career docs | Separate Python service, not linked |

## Design

### Three memory tiers (Postgres-first, deterministic)

```
Tier 1 — Episodic (what happened)
  episodic_memory table: event_type, title, summary, tags, occurred_at
  Written by: agents after key interactions, scheduler after sessions

Tier 2 — Conversation log (what was said)
  conversations table: thread_id, summary, topics, message_count
  Written by: auto-recorder after each Telegram conversation ends

Tier 3 — Knowledge base (what we know)
  knowledge_entries: turicks-brain (existing, synced via brain:sync)
  founder_context: business state JSONB (existing, 21 keys)
```

### Why Postgres (not vector DB) first
- Deterministic: keyword + recency search is reproducible at temperature=0
- Existing infra: reuses Drizzle ORM, Postgres already running
- Queryable by humans: founder can inspect with SQL
- Vector/semantic RAG is Phase 2 (pgvector + Fastembed) — wrong to add before basic recall works

### New tables

**`conversations`**
```sql
id serial PK
thread_id text NOT NULL          -- LangGraph thread_id
tenant_id text NOT NULL DEFAULT 'turicks'
started_at timestamptz
last_message_at timestamptz
summary text                     -- auto-generated, 2-3 sentences
topics text[]                    -- extracted: ["stripe", "linkedin", "code review"]
message_count integer DEFAULT 0
created_at timestamptz DEFAULT now()
```

**`episodic_memory`**
```sql
id serial PK
tenant_id text NOT NULL
event_type text NOT NULL         -- 'conversation', 'decision', 'outcome', 'task_completed', 'note'
occurred_at timestamptz NOT NULL DEFAULT now()
title text NOT NULL              -- "Discussed Stripe integration with Alex"
summary text                     -- 1-3 sentences of what happened
tags text[]                      -- ["stripe", "client", "integration"]
thread_id text                   -- links to conversation if relevant
source text DEFAULT 'telegram'   -- 'telegram', 'manual', 'scheduled'
created_at timestamptz DEFAULT now()
```

### New tools

**`search_memory`** (supervisor-level, read-only)
- Input: `query: string, type?: 'all' | 'conversations' | 'episodic' | 'context' | 'knowledge'`
- Searches: `episodic_memory` full-text + `conversations` summary/topics + `knowledge_entries` keyword + `founder_context` JSONB
- Returns: ranked by recency, formatted Markdown
- No HITL

**`record_event`** (any agent, HITL-gated for write)
- Input: `title, summary, tags[], event_type, occurred_at?`
- Writes to `episodic_memory`
- HITL: shows event title/summary before writing

### Auto-conversation recorder
`src/infra/conversation-recorder.ts`:
- Called by telegram.ts after each conversation completes
- Extracts summary from last AI message (or uses local Ollama qwen2.5:7b)
- Extracts topic tags from the summary
- Upserts to `conversations` table
- Adds one `episodic_memory` entry of type 'conversation'

### MCP manager layer (Phase 2)
After the Postgres memory is stable, expose a `memory_mcp` server that:
- Routes `search_memory(query)` calls to the right tier
- Handles personal-rag integration (reads wiki.md via HTTP API)
- Used by Claude Code (via .mcp.json) for context-aware coding

## ADR
→ `docs/decisions/016-memory-system-postgres-first.md`

## Success criteria
- [ ] `search_memory` returns relevant past conversations when asked "what did we discuss about X"
- [ ] Conversations auto-recorded after each Telegram session
- [ ] `pnpm test` green with memory tool tests
- [ ] No new npm packages required
- [ ] Works offline (no external API for basic recall)
