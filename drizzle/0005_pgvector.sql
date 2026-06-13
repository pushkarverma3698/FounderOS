-- FounderOS — pgvector RAG Migration
-- Consolidates the former ChromaDB stores into Postgres + pgvector.
-- Adds two SEPARATE vector tables (ADR-013/015 isolation — never cross-read):
--   personal_rag  — career/personal knowledge (personal-rag store)
--   turicks_brain — business/portfolio knowledge (turicks-brain store)
-- Plus an optional embedding column on knowledge_entries for hybrid search.
--
-- Indexes use HNSW with cosine distance (vector_cosine_ops).
-- Requires the pgvector extension (pgvector/pgvector:pg16 image, or apt install).
--
-- Run with: pnpm db:migrate
-- Applied: 2026-06-13

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "personal_rag" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "content"    TEXT NOT NULL,
  "metadata"   JSONB DEFAULT '{}'::jsonb,
  "embedding"  VECTOR(768),
  "created_at" TIMESTAMPTZ DEFAULT NOW()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "turicks_brain" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "content"    TEXT NOT NULL,
  "metadata"   JSONB DEFAULT '{}'::jsonb,
  "embedding"  VECTOR(768),
  "created_at" TIMESTAMPTZ DEFAULT NOW()
);
--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD COLUMN IF NOT EXISTS "embedding" VECTOR(768);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS personal_rag_embedding_idx
  ON personal_rag USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS turicks_brain_embedding_idx
  ON turicks_brain USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS knowledge_entries_embedding_idx
  ON knowledge_entries USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
