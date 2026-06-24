-- FounderOS — research_cache vector store (Apify research memory)
-- Durable memory of web pages scraped by the research department (Apify
-- rag-web-browser / website-content-crawler). Kept SEPARATE from the curated
-- turicks_brain so raw web content never pollutes hand-synced strategy docs
-- (ADR-013/015 separation spirit). Auto-ingested by src/infra/research-memory.ts;
-- queried by search_research_cache (src/db/rag-search.ts allowlist).
--
-- Mirrors turicks_brain (0005_pgvector): 768-dim vectors, HNSW cosine index.
-- Lives in the brain schema (search_path = agents, brain, public).
--
-- Run with: pnpm db:migrate
-- Applied: 2026-06-24

CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brain"."research_cache" (
  "id"         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "content"    TEXT NOT NULL,
  "metadata"   JSONB DEFAULT '{}'::jsonb,
  "embedding"  VECTOR(768),
  "created_at" TIMESTAMPTZ DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS research_cache_embedding_idx
  ON "brain"."research_cache" USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
--> statement-breakpoint
-- Idempotent ingest deletes prior chunks by metadata->>'source_url' before
-- re-inserting; a btree index on that expression keeps the refresh fast.
CREATE INDEX IF NOT EXISTS research_cache_source_url_idx
  ON "brain"."research_cache" ((metadata->>'source_url'));
