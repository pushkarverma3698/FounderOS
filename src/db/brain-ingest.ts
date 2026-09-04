import { eq, and } from "drizzle-orm";
import { db } from "./client.js";
import { brainMemories } from "./schema.js";
import { embedText } from "../lib/embed.js";
import { createHash } from "crypto";

export interface IngestOptions {
  memoryType: string;
  content: string;
  source?: string;
  sourceId?: string;
  project?: string;
  importance?: number;
  confidence?: number;
  status?: string;
  metadata?: Record<string, unknown>;
  tenantId?: string;
}

/**
 * Unified ingestion pipeline for the Turicks Brain (ADR-038).
 * Normalizes, embeds, and inserts memories into the canonical PostgreSQL store.
 */
export async function brainIngest(opts: IngestOptions): Promise<{ id: string }> {
  // 1. Normalize
  const content = opts.content.trim();
  if (!content) {
    throw new Error("Cannot ingest empty memory content");
  }

  const tenantId = opts.tenantId ?? "turicks";
  const sourceId = opts.sourceId ?? createHash("sha256").update(content).digest("hex");

  // 2. Deduplicate
  // If we already have this exact source_id in this tenant with this type, we can update it or skip.
  const existing = await db
    .select({ id: brainMemories.id, content: brainMemories.content })
    .from(brainMemories)
    .where(
      and(
        eq(brainMemories.tenant_id, tenantId),
        eq(brainMemories.source_id, sourceId),
        eq(brainMemories.memory_type, opts.memoryType)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const record = existing[0]!;
    if (record.content === content) {
      // Content unchanged, skip embedding and update
      return { id: record.id };
    }
    
    // 3 & 4. Embed and Update
    const embedding = await embedText(content);
    await db
      .update(brainMemories)
      .set({
        content,
        embedding: `[${embedding.join(",")}]` as any,
        metadata: opts.metadata ?? {},
        importance: opts.importance?.toString() ?? null,
        confidence: opts.confidence?.toString() ?? null,
        status: opts.status ?? "ACTIVE",
        updated_at: new Date(),
      })
      .where(eq(brainMemories.id, record.id));
    
    return { id: record.id };
  }

  // 3 & 4. Embed and Insert
  const embedding = await embedText(content);
  
  const inserted = await db
    .insert(brainMemories)
    .values({
      tenant_id: tenantId,
      memory_type: opts.memoryType,
      content,
      embedding: `[${embedding.join(",")}]` as any,
      source: opts.source ?? null,
      source_id: sourceId,
      project: opts.project ?? null,
      importance: opts.importance?.toString() ?? null,
      confidence: opts.confidence?.toString() ?? null,
      status: opts.status ?? "ACTIVE",
      metadata: opts.metadata ?? {},
    })
    .returning({ id: brainMemories.id });

  return { id: inserted[0]!.id };
}
