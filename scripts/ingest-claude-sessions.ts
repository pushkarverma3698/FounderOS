/**
 * FounderOS — ingest local Claude Code work into the brain (`pnpm ingest:claude`).
 * ==============================================================================
 * Every Claude Code session on this laptop writes a transcript to
 * `~/.claude/projects/<slug>/<session>.jsonl`, and every consolidated fact lands
 * in `<slug>/memory/*.md`. None of it ever reached the brain, so the Telegram bot
 * and every future session started blind to work that had already been done.
 *
 * Two tiers, deliberately different in kind:
 *   claude_memory   — the curated memory/*.md files. Small, dense, already
 *                     distilled by hand. This is the signal.
 *   claude_session  — distilled transcripts (founder prose + concluded answers,
 *                     no tool payloads, no thinking, no pastes over 4 KB).
 *
 * NOT ingested: raw transcripts. 204.7 MB of them for this repo alone, of which
 * 98.4% is tool_use/tool_result — files already in git, re-embedded as prose.
 * Founder directive 2026-08-07, after measurement: distil, never dump.
 *
 * Idempotent: rows are keyed by `metadata->>'source'` and replaced wholesale, so
 * a re-run is a no-op for unchanged sessions and a clean replace for changed ones.
 *
 * Usage:
 *   pnpm ingest:claude                 # every project
 *   pnpm ingest:claude -- --project founderos
 *   pnpm ingest:claude -- --dry-run    # report what would change, write nothing
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { chunkText, embedTexts } from "../src/lib/embed.js";
import { distillSession, renderSession } from "../src/lib/claude-transcript.js";

const PROJECTS_DIR = join(process.env["HOME"] ?? "", ".claude", "projects");

/** Sessions with fewer real turns than this are throat-clearing, not work. */
const MIN_TURNS_WORTH_KEEPING = 4;

interface Document {
  readonly source: string;
  readonly docType: "claude_memory" | "claude_session";
  readonly title: string;
  readonly text: string;
  /** Latest activity — used to skip sessions that have not moved since last run. */
  readonly updatedAt: Date;
}

// ── Collection (I/O only — no embedding, no writes) ──────────────────────────

/** The `memory/*.md` files: hand-distilled facts, one per file. */
function collectMemoryDocs(projectDir: string, slug: string): Document[] {
  const memoryDir = join(projectDir, "memory");
  if (!existsSync(memoryDir)) return [];

  const docs: Document[] = [];
  for (const file of readdirSync(memoryDir)) {
    if (!file.endsWith(".md")) continue;
    const path = join(memoryDir, file);
    const text = readFileSync(path, "utf-8").trim();
    if (text.length === 0) continue;

    docs.push({
      source: `claude-memory:${slug}/${file}`,
      docType: "claude_memory",
      title: file.replace(/\.md$/, ""),
      text,
      updatedAt: statSync(path).mtime,
    });
  }
  return docs;
}

/** Distilled session transcripts. The subtraction happens in claude-transcript.ts. */
function collectSessionDocs(projectDir: string, slug: string): Document[] {
  const docs: Document[] = [];
  for (const file of readdirSync(projectDir)) {
    if (!file.endsWith(".jsonl")) continue;

    const path = join(projectDir, file);
    const sessionId = file.replace(/\.jsonl$/, "");
    const session = distillSession(readFileSync(path, "utf-8"), sessionId);
    if (session.turns.length < MIN_TURNS_WORTH_KEEPING) continue;

    const text = renderSession(session);
    if (text.length === 0) continue;

    docs.push({
      source: `claude-session:${slug}/${sessionId}`,
      docType: "claude_session",
      title: `${slug} session ${sessionId.slice(0, 8)}`,
      text,
      updatedAt: session.lastActivity ?? statSync(path).mtime,
    });
  }
  return docs;
}

export function collectDocuments(projectFilter?: string): Document[] {
  if (!existsSync(PROJECTS_DIR)) {
    throw new Error(`No Claude projects directory at ${PROJECTS_DIR}`);
  }

  const docs: Document[] = [];
  for (const slug of readdirSync(PROJECTS_DIR)) {
    if (projectFilter && !slug.includes(projectFilter)) continue;
    const projectDir = join(PROJECTS_DIR, slug);
    if (!statSync(projectDir).isDirectory()) continue;

    docs.push(...collectMemoryDocs(projectDir, slug), ...collectSessionDocs(projectDir, slug));
  }
  return docs;
}

// ── Write path ───────────────────────────────────────────────────────────────

/**
 * Which sources are already stored at or after their current mtime.
 *
 * Re-embedding 1,856 unchanged chunks every 30 minutes would burn the laptop's
 * CPU for no new information, so the skip is what makes this safe to run on a
 * timer rather than by hand.
 */
async function loadStoredWatermarks(): Promise<Map<string, number>> {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT source,
           max(metadata->>'updated_at') AS updated_at
    FROM brain.brain_memories
    WHERE source LIKE 'claude-%'
    GROUP BY 1
  `);

  const watermarks = new Map<string, number>();
  for (const row of rows as unknown as Array<{ source: string; updated_at: string | null }>) {
    const stamp = row.updated_at ? Date.parse(row.updated_at) : NaN;
    if (row.source && !Number.isNaN(stamp)) watermarks.set(row.source, stamp);
  }
  return watermarks;
}

/** Replace one document's chunks. Delete-then-insert, so a shrunk doc leaves no tail. */
async function storeDocument(doc: Document): Promise<number> {
  const db = getDb();
  const chunks = chunkText(doc.text);
  const embeddings = await embedTexts(chunks);

  await db.execute(sql`
    DELETE FROM brain.brain_memories WHERE source = ${doc.source}
  `);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const vector = embeddings[i];
    if (!chunk || !vector || vector.length === 0) continue;

    const metadata = JSON.stringify({
      source: doc.source,
      doc_type: doc.docType,
      title: doc.title,
      chunk_index: i,
      total_chunks: chunks.length,
      updated_at: doc.updatedAt.toISOString(),
    });

    await db.execute(sql`
      INSERT INTO brain.brain_memories (tenant_id, memory_type, content, metadata, embedding, source, status)
      VALUES (
        'turicks',
        ${doc.docType},
        ${chunk},
        ${metadata}::jsonb,
        ${`[${vector.join(",")}]`}::vector,
        ${doc.source},
        'ACTIVE'
      )
    `);
  }
  return chunks.length;
}

export interface IngestReport {
  readonly scanned: number;
  readonly skipped: number;
  readonly ingested: number;
  readonly chunks: number;
  readonly failures: readonly string[];
}

export async function ingestClaudeWork(
  options: { projectFilter?: string; dryRun?: boolean } = {},
): Promise<IngestReport> {
  const docs = collectDocuments(options.projectFilter);
  const watermarks = await loadStoredWatermarks();

  const stale = docs.filter((doc) => {
    const stored = watermarks.get(doc.source);
    return stored === undefined || doc.updatedAt.getTime() > stored;
  });

  if (options.dryRun) {
    return {
      scanned: docs.length,
      skipped: docs.length - stale.length,
      ingested: 0,
      chunks: stale.reduce((n, d) => n + chunkText(d.text).length, 0),
      failures: [],
    };
  }

  let chunks = 0;
  let ingested = 0;
  const failures: string[] = [];

  for (const doc of stale) {
    try {
      chunks += await storeDocument(doc);
      ingested += 1;
    } catch (err) {
      // Never abort the batch: one unreadable session must not cost the other 56.
      failures.push(`${doc.source}: ${(err as Error).message}`);
    }
  }

  return { scanned: docs.length, skipped: docs.length - stale.length, ingested, chunks, failures };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const projectIndex = args.indexOf("--project");
  const projectFilter = projectIndex >= 0 ? args[projectIndex + 1] : undefined;

  const report = await ingestClaudeWork({
    ...(projectFilter ? { projectFilter } : {}),
    dryRun,
  });

  console.log(`${dryRun ? "[dry run] " : ""}Claude work → brain.brain_memories`);
  console.log(`  documents scanned : ${report.scanned}`);
  console.log(`  unchanged, skipped: ${report.skipped}`);
  console.log(`  ${dryRun ? "would ingest      " : "ingested          "}: ${dryRun ? report.scanned - report.skipped : report.ingested}`);
  console.log(`  chunks            : ${report.chunks}`);

  if (report.failures.length > 0) {
    // Loud: a partial ingest that reported success would be indistinguishable
    // from a complete one, and the brain would be quietly missing sessions.
    console.error(`\n  ${report.failures.length} document(s) FAILED:`);
    for (const failure of report.failures) console.error(`    · ${failure}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Claude ingestion failed:", err);
    process.exit(1);
  });
}
