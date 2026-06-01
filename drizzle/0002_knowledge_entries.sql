-- turicks-brain: knowledge_entries table
-- Stores ADRs, brand guidelines, strategic pillars, phase docs, case study entries.
-- Idempotent: uses title as logical key; old versions set is_current=false.

CREATE TABLE IF NOT EXISTS "knowledge_entries" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"   text NOT NULL DEFAULT 'turicks',
  "entry_type"  text NOT NULL,
  "title"       text NOT NULL,
  "content"     text NOT NULL,
  "source"      text,
  "tags"        jsonb DEFAULT '[]',
  "version"     integer NOT NULL DEFAULT 1,
  "is_current"  boolean NOT NULL DEFAULT true,
  "metadata"    jsonb,
  "created_at"  timestamptz DEFAULT now(),
  "updated_at"  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ke_type_idx"  ON "knowledge_entries" ("tenant_id", "entry_type", "is_current");
CREATE INDEX IF NOT EXISTS "ke_title_idx" ON "knowledge_entries" ("title");
