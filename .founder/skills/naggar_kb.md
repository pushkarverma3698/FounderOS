---
name: naggar_kb
user-invocable: true
---

## Expert Knowledge Indexing — KB Agent (Naggar)
Cascade: LOCAL (Qwen 2.5 7B) | Privacy: ALL farm/guest data — local ONLY

### Nightly Indexing Protocol (23:00 IST)
1. Collect all Naggar agent outputs from last 24h
2. Chunk: 200-400 tokens with 50-token overlap
3. Tag: {agent, date, category: farm|guest|market|content, quality_score}
4. Store in `naggar_mem` ChromaDB
5. Prune >90 days old, quality_score <6

### Data Silo Enforcement (CRITICAL)
NEVER write Naggar data to `turicks_mem`.
NEVER read from `turicks_mem` — raise DataSiloError if attempted.

### Quality Scoring
Contains specific numbers/dates → +3 | Agent-validated → +3
Directly actionable → +2 | <7 days old → +2

### Permissions: Write naggar_mem only. Read all Naggar output folders. NO cross-company access.