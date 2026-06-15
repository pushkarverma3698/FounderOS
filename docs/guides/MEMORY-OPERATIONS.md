# Memory Operations Guide

**FounderOS has two separate RAG systems:**
- `turicks-brain`: Business/portfolio knowledge (Postgres + pgvector)
- `personal-rag`: Career/personal knowledge (separate Postgres instance)
- `episodic_memory`: Decisions, outcomes, session logs

**Boundary (ADR-013/015):** Never cross-write. They're separate for a reason.

## Populating turicks-brain

**How:** `pnpm brain:sync` syncs docs to knowledge_entries table.

**What it reads:**
- `docs/decisions/` (ADRs)
- `docs/phases/` (phase docs)
- `docs/superpowers/specs/` (design specs)
- `docs/BRAND.md` (brand guidelines)

**What it does:**
- Reads each `.md` file
- Chunks content
- Generates embeddings (Ollama nomic-embed-text locally)
- Upserts to `knowledge_entries` table (indexed by pgvector)

**Command:**
```bash
pnpm brain:sync
# Reads docs/ → generates embeddings → upserts knowledge_entries
```

**Verify:**
```sql
SELECT COUNT(*) FROM knowledge_entries;
SELECT * FROM knowledge_entries LIMIT 1;
-- Should show: id, content, embedding, metadata (doc_type, doc_path)
```

## Populating personal-rag

**How:** Manual ingestion script (separate Postgres instance).

**Command:**
```bash
cd ~/Projects/personal-rag
python scripts/ingest_local_docs.py
# Reads ~/Projects/personal-rag/docs/* → upserts to personal-rag Postgres
```

**Content:** CV, resume, portfolio projects, career notes.

**Boundary:** Read-only from FounderOS. Never auto-submit applications or send emails on behalf of personal-rag.

## Querying Memory

### search_knowledge (turicks-brain)

```typescript
export async function search_knowledge(query: string, limit = 5) {
  // Keyword ILIKE + semantic similarity on turicks-brain
  // Returns: [{ content, metadata, relevance_score }]
}
```

**Example:**
```bash
search_knowledge("LangGraph patterns")
# Returns: ADR-010, ADR-025 (hierarchy proof), phase docs mentioning LangGraph
```

### search_personal_rag (personal knowledge)

```typescript
export async function search_personal_rag(query: string, limit = 5) {
  // Keyword ILIKE + semantic on personal-rag Postgres
  // Returns: [{ content, type, relevance }]
}
```

**Example:**
```bash
search_personal_rag("Claude API experience")
# Returns: CV entries, portfolio projects, resume
```

## Troubleshooting

### "search_knowledge returns nothing"

**Diagnosis:**
```sql
SELECT COUNT(*) FROM knowledge_entries;
-- If 0, docs haven't been synced
```

**Fix:**
```bash
pnpm brain:sync
# Wait for completion, then retry search
```

### "Results are stale"

**Diagnosis:**
```sql
SELECT MAX(last_synced) FROM knowledge_entries;
-- If > 1 hour ago, docs may be outdated
```

**Fix:**
```bash
pnpm brain:sync
# Re-sync all docs (idempotent, safe)
```

### "Hits are too generic"

**Current limitation:** Keyword-based only (ILIKE), not semantic ranking.

**Roadmap:** Chroma migration (Phase E) will add semantic relevance ranking.

## Limitations & Roadmap

### Current Limitations
- Keyword search only (no semantic ranking)
- Max 5 results per query (truncated)
- No faceted search (can't filter by doc type)
- All documents indexed together (no multi-tenant)

### Phase E Roadmap
- Migrate to Chroma for semantic search
- Add relevance ranking
- Support multi-tenant isolation
- Implement faceted search (filter by date, type, status)

## Memory as Single Source of Truth (Rule #18)

**At end of every session that changed state:**

1. **turicks-brain**: Run `pnpm brain:sync` (new ADRs, phase docs, decisions)
2. **Episodic memory**: Log significant decisions via `record_event` tool
3. **personal-rag**: Update personal portfolio + re-ingest via Python script
4. **MEMORY.md**: Update `.claude/projects/.../memory/MEMORY.md` (fast index)

**Why:** Everything Claude does should persist to the DB, not just chat history.

---

See [PHASE-C-INTELLIGENCE.md](../phases/PHASE-C-INTELLIGENCE.md) for full context/memory/scheduler Phase.
