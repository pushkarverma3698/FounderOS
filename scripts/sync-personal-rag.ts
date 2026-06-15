/**
 * sync-personal-rag.ts
 * ====================
 * Ingests the founder's personal career docs into the personal_rag pgvector
 * table so search_personal_rag can answer questions like "what are my skills?",
 * "draft a cover letter for X", and "match my background to this JD".
 *
 * Sources:
 *   ~/Projects/personal-rag/data/wiki.md           → doc_type: resume
 *   ~/Projects/personal-rag/data/local_docs/*.md   → doc_type: work_experience
 *
 * Design (ADR-013/015):
 *   - ONLY writes to personal_rag — never to knowledge_entries or turicks_brain.
 *   - The personal↔business knowledge boundary is structural: personal career
 *     data never enters the turicks-brain store, and business data never enters
 *     personal-rag.
 *
 * Run:
 *   pnpm personal:sync
 *
 * Idempotent: per-source DELETE + INSERT (old chunks replaced each run).
 * Requires: Ollama running + nomic-embed-text pulled, Postgres + pgvector up.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { embedText, embedTexts, chunkText } from "../src/lib/embed.js";

function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

interface PersonalDoc {
  source_file: string;
  doc_type: string;
  content: string;
}

const PERSONAL_RAG_DIR = join(process.env["HOME"] ?? "", "Projects/personal-rag/data");

function collectDocs(): PersonalDoc[] {
  const docs: PersonalDoc[] = [];

  // ── wiki.md — synthesized CV (always first) ───────────────────────────────
  const wikiPath = join(PERSONAL_RAG_DIR, "wiki.md");
  if (existsSync(wikiPath)) {
    docs.push({
      source_file: "wiki.md",
      doc_type: "resume",
      content: readFileSync(wikiPath, "utf-8"),
    });
  } else {
    console.warn(`⚠️  wiki.md not found at ${wikiPath} — skipping`);
  }

  // ── local_docs/*.md — portfolio briefs, career highlights, etc. ──────────
  const localDocsDir = join(PERSONAL_RAG_DIR, "local_docs");
  if (existsSync(localDocsDir)) {
    for (const file of readdirSync(localDocsDir).filter((f) => f.endsWith(".md"))) {
      const content = readFileSync(join(localDocsDir, file), "utf-8");
      if (!content.trim()) continue;
      docs.push({
        source_file: file,
        doc_type: "work_experience",
        content,
      });
    }
  } else {
    console.warn(`⚠️  local_docs/ not found at ${localDocsDir} — skipping`);
  }

  return docs;
}

/**
 * Replace all chunks for a given source_file, then insert freshly-embedded ones.
 * Returns the number of chunks inserted.
 */
async function syncDoc(doc: PersonalDoc): Promise<number> {
  const db = getDb();
  const chunks = chunkText(doc.content);
  if (chunks.length === 0) return 0;

  const embeddings = await embedTexts(chunks);

  // Idempotent: remove stale chunks from a previous sync run.
  await db.execute(
    sql`DELETE FROM personal_rag WHERE metadata->>'source_file' = ${doc.source_file}`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const metadata = {
      source_file: doc.source_file,
      doc_type: doc.doc_type,
      chunk_index: i,
      chunk_count: chunks.length,
    };
    await db.execute(sql`
      INSERT INTO personal_rag (content, metadata, embedding)
      VALUES (${chunks[i]!}, ${JSON.stringify(metadata)}::jsonb, ${toVector(embeddings[i]!)}::vector)
    `);
  }
  return chunks.length;
}

async function main() {
  console.log("👤 Syncing personal docs to personal_rag (pgvector)…\n");
  console.log(`   Source dir: ${PERSONAL_RAG_DIR}\n`);

  // Fail loud before any writes if Ollama is unavailable (same guard as brain:sync).
  try {
    await embedText("connectivity probe");
  } catch (err) {
    console.error(
      `❌ Ollama unavailable — aborting before any write.\n   ${(err as Error).message}\n` +
        `   Ensure Ollama is running and nomic-embed-text is pulled:\n` +
        `     ollama pull nomic-embed-text`,
    );
    process.exit(1);
  }

  const docs = collectDocs();
  if (docs.length === 0) {
    console.error("❌ No documents found — check the personal-rag data directory.");
    process.exit(1);
  }
  console.log(`Found ${docs.length} document(s) to sync.\n`);

  let totalChunks = 0;
  let failures = 0;

  for (const doc of docs) {
    try {
      const chunks = await syncDoc(doc);
      totalChunks += chunks;
      console.log(`✅ ${doc.source_file} (${doc.doc_type}) — ${chunks} chunks`);
    } catch (err) {
      failures++;
      console.error(`❌ Failed: ${doc.source_file} — ${(err as Error).message}`);
    }
  }

  console.log(
    `\n✅ Sync complete: ${docs.length - failures} docs · ${totalChunks} chunks → personal_rag` +
      (failures > 0 ? ` · ${failures} FAILED` : ""),
  );
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
