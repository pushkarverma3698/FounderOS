-- ADR-038, part 2: make the readers and the writer name the SAME table.
--
-- 0037 created brain.brain_memories and repointed scripts/sync-turicks-brain.ts
-- at it, but every retrieval path — search_knowledge, search_turicks_brain, the
-- RAG health sweep — still read brain.turicks_brain. Shipping that pair means
-- brain:sync writes rows nobody reads while retrieval serves a table nobody
-- writes: every doc synced from then on is invisible to the agent, and the old
-- table answers with content that can never be refreshed. That is the
-- 2026-08-07 shadow-table failure again (an empty agents.turicks_brain shadowed
-- the real one for weeks) — silent, and indistinguishable from "nothing matched".
--
-- This carries the existing corpus across so flipping the read path is a no-op
-- for retrieval, and adds the HNSW index 0037 omitted. Without it every semantic
-- search over the new table is a sequential scan; brain.turicks_brain has had
-- one since 0005_pgvector.
--
-- Idempotent: source_id is the chunk's own sha256, so a re-run inserts nothing.
-- The hash matches contentSha() in scripts/sync-turicks-brain.ts (sha256 over
-- UTF-8 bytes, hex) so the sync's "already present, skip re-embedding" path
-- keeps working over backfilled rows instead of re-embedding the whole corpus.

INSERT INTO "brain"."brain_memories"
  (tenant_id, memory_type, content, embedding, source, source_id, status, metadata, created_at)
SELECT
  'turicks',
  COALESCE(NULLIF(tb.metadata->>'entry_type', ''), 'document'),
  tb.content,
  tb.embedding,
  tb.metadata->>'source_path',
  encode(sha256(convert_to(tb.content, 'UTF8')), 'hex'),
  'ACTIVE',
  COALESCE(tb.metadata, '{}'::jsonb),
  COALESCE(tb.created_at, now())
FROM "brain"."turicks_brain" tb
WHERE NOT EXISTS (
  SELECT 1 FROM "brain"."brain_memories" bm
  WHERE bm.tenant_id = 'turicks'
    AND bm.source_id = encode(sha256(convert_to(tb.content, 'UTF8')), 'hex')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_memories_embedding_idx"
  ON "brain"."brain_memories" USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
