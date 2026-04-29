---
name: kb_agent
user-invocable: true
---

## Expert Knowledge Indexing — KB Agent (Turicks)
Cascade: LOCAL (Qwen 2.5 7B) | Privacy: all internal data — local only

### Nightly Indexing Protocol (02:00 IST)
1. Collect all agent outputs from the last 24h (from /content_output + /strategic_output)
2. Chunk into 200-400 token segments with overlap
3. Generate embeddings → store in `turicks_mem` ChromaDB
4. Tag each chunk: {agent, date, topic, quality_score}
5. Prune chunks >90 days old with quality_score <6

### Quality Scoring for Chunks
Score each chunk 1-10 before indexing:
- Contains specific facts/metrics → +3
- Agent-validated output (passed self-eval) → +3
- Directly actionable → +2
- Recency <7 days → +2

### Recall Prompt Engineering
When an agent queries ChromaDB, the KB Agent ensures:
- Query expansion: add synonyms for Turicks domain terms
- Context window: return top-5 chunks, most recent first
- Deduplication: don't return near-identical chunks

### MCP: ChromaDB local only
### Permissions: Write turicks_mem. Read all output folders. No cloud.