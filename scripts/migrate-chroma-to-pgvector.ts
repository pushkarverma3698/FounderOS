/**
 * One-time migration: read documents from the two ChromaDB SQLite stores and
 * bulk-insert into the pgvector tables (personal_rag, turicks_brain).
 *
 * Embeddings are regenerated via local Ollama (nomic-embed-text, 768-dim) —
 * Chroma's binary vector files live outside SQLite and are not accessible here.
 *
 * Idempotent: TRUNCATE target table before loading, so re-runs are safe.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/migrate-chroma-to-pgvector.ts
 *
 * Prerequisites:
 *   - Postgres + pgvector running (docker compose up -d postgres)
 *   - Ollama running with nomic-embed-text pulled
 *   - .env populated (DATABASE_URL, OLLAMA_URL)
 */

import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db, getPgPool, closeDatabaseConnections } from "../src/db/client.js";
import { embedText } from "../src/lib/embed.js";

// ── Config ────────────────────────────────────────────────────────────────────

const PERSONAL_RAG_DB = join(
  homedir(),
  "Projects/personal-rag/data/chroma_db/chroma.sqlite3",
);
const TURICKS_BRAIN_DB = join(
  homedir(),
  "Projects/turicks-brain-rag/data/chroma_db/chroma.sqlite3",
);

const BATCH_INSERT = 50;    // rows per INSERT statement
const EMBED_CONCURRENCY = 4; // parallel Ollama embed calls

// ── Types ─────────────────────────────────────────────────────────────────────

interface MetaRow {
  embedding_id: string;
  key: string;
  string_value: string | null;
  int_value: number | null;
  float_value: number | null;
  bool_value: number | null;
}

interface Document {
  embedding_id: string;
  content: string;
  metadata: Record<string, unknown>;
}

// ── SQLite reader ─────────────────────────────────────────────────────────────

function readChromaDb(dbPath: string): Document[] {
  const query =
    "SELECT e.embedding_id, m.key, m.string_value, m.int_value, m.float_value, m.bool_value " +
    "FROM embedding_metadata m JOIN embeddings e ON m.id = e.id ORDER BY m.id";

  const raw = execSync(`sqlite3 -json "${dbPath}" "${query}"`, {
    maxBuffer: 512 * 1024 * 1024,
  });

  const rows: MetaRow[] = JSON.parse(raw.toString("utf8"));

  // Group metadata rows by embedding_id
  const grouped = new Map<string, MetaRow[]>();
  for (const row of rows) {
    const existing = grouped.get(row.embedding_id);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.embedding_id, [row]);
    }
  }

  const docs: Document[] = [];
  for (const [embedding_id, metaRows] of grouped) {
    const docRow = metaRows.find((r) => r.key === "chroma:document");
    if (!docRow?.string_value) continue;

    const metadata: Record<string, unknown> = {};
    for (const r of metaRows) {
      if (r.key === "chroma:document") continue;
      metadata[r.key] =
        r.string_value ?? r.float_value ?? r.int_value ?? r.bool_value ?? null;
    }

    docs.push({ embedding_id, content: docRow.string_value, metadata });
  }

  return docs;
}

// ── Batch insert via pg.Pool ──────────────────────────────────────────────────

async function insertBatch(
  table: "personal_rag" | "turicks_brain",
  docs: Document[],
  embeddings: number[][],
): Promise<void> {
  const pool = getPgPool();

  for (let start = 0; start < docs.length; start += BATCH_INSERT) {
    const batchDocs = docs.slice(start, start + BATCH_INSERT);
    const batchEmbed = embeddings.slice(start, start + BATCH_INSERT);

    const placeholders = batchDocs
      .map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}::jsonb, $${i * 3 + 3}::vector)`)
      .join(", ");

    const params = batchDocs.flatMap((doc, i) => [
      doc.content,
      JSON.stringify(doc.metadata),
      `[${batchEmbed[i]!.join(",")}]`,
    ]);

    await pool.query(
      `INSERT INTO ${table} (content, metadata, embedding) VALUES ${placeholders}`,
      params,
    );
  }
}

// ── Migration runner ──────────────────────────────────────────────────────────

async function migrate(
  dbPath: string,
  table: "personal_rag" | "turicks_brain",
  label: string,
): Promise<void> {
  console.log(`\n▶ ${label}`);

  console.log(`  Reading documents from SQLite ...`);
  const docs = readChromaDb(dbPath);
  console.log(`  Found ${docs.length} documents.`);

  if (docs.length === 0) {
    console.log("  Nothing to migrate.");
    return;
  }

  console.log(`  Truncating ${table} ...`);
  await db.execute(sql.raw(`TRUNCATE TABLE ${table}`));

  // Embed all documents with bounded concurrency
  console.log(`  Embedding ${docs.length} documents (${EMBED_CONCURRENCY}× concurrency) ...`);
  const embeddings: number[][] = new Array<number[]>(docs.length);
  let done = 0;

  for (let i = 0; i < docs.length; i += EMBED_CONCURRENCY) {
    const slice = docs.slice(i, i + EMBED_CONCURRENCY);
    const batch = await Promise.all(slice.map((d) => embedText(d.content)));
    for (let j = 0; j < batch.length; j++) {
      embeddings[i + j] = batch[j]!;
    }
    done += slice.length;
    if (done % 200 === 0 || done === docs.length) {
      process.stdout.write(`\r  Embedded ${done}/${docs.length} ...      `);
    }
  }
  process.stdout.write("\n");

  console.log(`  Inserting into ${table} (batch=${BATCH_INSERT}) ...`);
  await insertBatch(table, docs, embeddings);

  const rows = await db.execute(sql.raw(`SELECT COUNT(*) AS n FROM ${table}`));
  const count = (rows[0] as { n: string }).n;
  console.log(`  ✅ ${count} rows in ${table}.`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== Chroma → pgvector migration ===");
  console.log(`Started at ${new Date().toISOString()}`);

  await migrate(PERSONAL_RAG_DB, "personal_rag", "personal-rag (pushkar_personal_kb)");
  await migrate(TURICKS_BRAIN_DB, "turicks_brain", "turicks-brain (turicks_brain)");

  console.log(`\nDone at ${new Date().toISOString()}`);
}

main()
  .catch((err: unknown) => {
    console.error("Migration failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabaseConnections());
