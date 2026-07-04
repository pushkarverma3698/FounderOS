/**
 * sync-turicks-brain.ts
 * =====================
 * Reads all docs (ADRs, brand guidelines, phase docs, strategic vision, case study)
 * and upserts them into the turicks-brain stores:
 *   1. knowledge_entries — keyword/title search (one versioned row per doc) +
 *      a doc-level embedding for hybrid search.
 *   2. turicks_brain     — the pgvector store the agents query via
 *      search_turicks_brain. Each doc is CHUNKED and every chunk embedded via
 *      local Ollama (nomic-embed-text, 768-dim). RAG text never leaves the box.
 *
 * Run after any architectural decision, brand update, or phase completion:
 *   pnpm brain:sync
 *
 * Idempotent:
 *   - knowledge_entries: title as upsert key; bumps version on content change.
 *   - turicks_brain: per-source refresh (delete this source's chunks, re-insert).
 *
 * Requires: Ollama running with nomic-embed-text pulled, Postgres + pgvector up.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/client.js";
import { knowledgeEntries } from "../src/db/schema.js";
import { eq, and } from "drizzle-orm";
import { embedText, embedTexts, chunkText } from "../src/lib/embed.js";

/** Postgres vector literal: number[] → "[1,2,3]". */
function toVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

interface DocEntry {
  entry_type: string;
  title: string;
  content: string;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

// ── Document manifest ─────────────────────────────────────────────────────────

function readFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

function titleFromFilename(filename: string): string {
  return basename(filename, ".md")
    .replace(/-/g, " ")
    .replace(/_/g, " ");
}

function collectDocs(rootDir: string): DocEntry[] {
  const docs: DocEntry[] = [];
  const root = join(process.cwd(), rootDir);

  // ── ADRs ────────────────────────────────────────────────────────────────────
  const decisionsDir = join(root, "docs/decisions");
  if (existsSync(decisionsDir)) {
    for (const file of readdirSync(decisionsDir).filter((f) => f.endsWith(".md"))) {
      const content = readFile(join(decisionsDir, file));
      const adrNum = file.match(/^(\d+)/)?.[1] ?? "0";
      docs.push({
        entry_type: "adr",
        title: titleFromFilename(file),
        content,
        source: `docs/decisions/${file}`,
        tags: ["architecture", "decision", `adr-${adrNum}`],
        metadata: { adr_number: parseInt(adrNum) },
      });
    }
  }

  // ── Strategic Vision ────────────────────────────────────────────────────────
  const strategicVision = join(root, "docs/architecture/STRATEGIC-VISION.md");
  if (existsSync(strategicVision)) {
    docs.push({
      entry_type: "strategic_pillar",
      title: "FounderOS Strategic Vision — 6 Pillars",
      content: readFile(strategicVision),
      source: "docs/architecture/STRATEGIC-VISION.md",
      tags: ["strategy", "architecture", "pillars", "token-economy", "saas-roadmap"],
      metadata: { pillar_count: 6 },
    });
  }

  // ── Brand Guidelines ────────────────────────────────────────────────────────
  const brandDoc = join(root, "docs/BRAND.md");
  if (existsSync(brandDoc)) {
    docs.push({
      entry_type: "brand",
      title: "Turicks Brand Guidelines (project summary)",
      content: readFile(brandDoc),
      source: "docs/BRAND.md",
      tags: ["brand", "voice", "guidelines", "turicks"],
    });
  }

  // Global brand guidelines (from ~/.claude)
  const globalBrand = join(process.env["HOME"] ?? "", ".claude/brand-guidelines/TURICKS.md");
  if (existsSync(globalBrand)) {
    docs.push({
      entry_type: "brand",
      title: "Turicks Brand Guidelines (full)",
      content: readFile(globalBrand),
      source: "~/.claude/brand-guidelines/TURICKS.md",
      tags: ["brand", "voice", "guidelines", "icp", "channel-rules", "banned-phrases"],
    });
  }

  // ── Strategy docs (Autonomous Studio — ADR-032) ─────────────────────────────
  const strategyDir = join(root, "docs/strategy");
  if (existsSync(strategyDir)) {
    for (const file of readdirSync(strategyDir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
      const content = readFile(join(strategyDir, file));
      docs.push({
        entry_type: "strategy",
        title: titleFromFilename(file),
        content,
        source: `docs/strategy/${file}`,
        tags: ["strategy", "gtm", "autonomous-studio", "turicks"],
      });
    }
  }

  // ── Roadmap (business + FounderOS direction) ─────────────────────────────────
  const roadmapDoc = join(root, "docs/ROADMAP.md");
  if (existsSync(roadmapDoc)) {
    docs.push({
      entry_type: "strategy",
      title: "FounderOS Roadmap and Strategic Direction",
      content: readFile(roadmapDoc),
      source: "docs/ROADMAP.md",
      tags: ["strategy", "roadmap", "phase", "turicks"],
    });
  }

  // ── Phase Docs ──────────────────────────────────────────────────────────────
  const phasesDir = join(root, "docs/phases");
  if (existsSync(phasesDir)) {
    for (const file of readdirSync(phasesDir).filter((f) => f.endsWith(".md"))) {
      const content = readFile(join(phasesDir, file));
      const phaseNum = file.match(/PHASE-(\d+)/i)?.[1] ?? "0";
      docs.push({
        entry_type: "phase",
        title: titleFromFilename(file),
        content,
        source: `docs/phases/${file}`,
        tags: ["phase", `phase-${phaseNum}`, "progress"],
        metadata: { phase_number: parseInt(phaseNum) },
      });
    }
  }

  // ── Study docs (case study, strategy, research) — all .md ────────────────────
  const studyDir = join(root, "docs/study");
  if (existsSync(studyDir)) {
    for (const f of readdirSync(studyDir).filter((f) => f.endsWith(".md"))) {
      const isCaseStudy = /CASE-STUDY/i.test(f);
      docs.push({
        entry_type: isCaseStudy ? "case_study" : "strategy",
        title: isCaseStudy ? "Turicks / FounderOS Case Study Log" : titleFromFilename(f),
        content: readFile(join(studyDir, f)),
        source: `docs/study/${f}`,
        tags: isCaseStudy
          ? ["case-study", "milestones", "metrics", "timeline"]
          : ["strategy", "study", "research"],
      });
    }
  }

  // ── Architecture Doc ────────────────────────────────────────────────────────
  const archDoc = join(root, "docs/architecture.md");
  if (existsSync(archDoc)) {
    docs.push({
      entry_type: "strategic_pillar",
      title: "FounderOS Architecture Overview",
      content: readFile(archDoc),
      source: "docs/architecture.md",
      tags: ["architecture", "system-design", "layers"],
    });
  }

  // ── Founder Profile ──────────────────────────────────────────────────────────
  // Operational context: who Pushkar is, Turicks/Naggar Retreat, 2026 goals,
  // working style. Enables agents to answer "who is Pushkar?" via search_knowledge
  // without asking him — satisfies the SELF-QUERY BEFORE ASKING rule.
  // Boundary: personal career/portfolio data lives in personal-rag, NOT here (ADR-013/015).
  const founderProfile = join(root, "docs/FOUNDER-PROFILE.md");
  if (existsSync(founderProfile)) {
    docs.push({
      entry_type: "founder_profile",
      title: "Founder Profile — Pushkar Verma",
      content: readFile(founderProfile),
      source: "docs/FOUNDER-PROFILE.md",
      tags: ["founder", "profile", "turicks", "naggar", "pushkar", "icp", "goals"],
    });
  }

  return docs;
}

// ── Upsert logic ──────────────────────────────────────────────────────────────

async function upsertEntry(
  entry: DocEntry,
  docEmbedding: number[] | null,
): Promise<{ action: "inserted" | "updated" | "skipped"; id: string }> {
  const db = getDb();
  const existing = await db
    .select()
    .from(knowledgeEntries)
    .where(
      and(
        eq(knowledgeEntries.tenant_id, "turicks"),
        eq(knowledgeEntries.title, entry.title),
        eq(knowledgeEntries.is_current, true),
      ),
    )
    .limit(1);

  if (existing.length === 0) {
    const [row] = await db
      .insert(knowledgeEntries)
      .values({
        tenant_id: "turicks",
        entry_type: entry.entry_type,
        title: entry.title,
        content: entry.content,
        source: entry.source,
        tags: entry.tags,
        metadata: entry.metadata,
        version: 1,
        is_current: true,
      })
      .returning({ id: knowledgeEntries.id });
    if (docEmbedding) await setKnowledgeEmbedding(row!.id, docEmbedding);
    return { action: "inserted", id: row!.id };
  }

  const current = existing[0]!;
  if (current.content === entry.content) {
    if (docEmbedding) await setKnowledgeEmbedding(current.id, docEmbedding);
    return { action: "skipped", id: current.id };
  }

  // Content changed — mark old as non-current, insert new version
  await db
    .update(knowledgeEntries)
    .set({ is_current: false })
    .where(eq(knowledgeEntries.id, current.id));

  const [row] = await db
    .insert(knowledgeEntries)
    .values({
      tenant_id: "turicks",
      entry_type: entry.entry_type,
      title: entry.title,
      content: entry.content,
      source: entry.source,
      tags: entry.tags,
      metadata: entry.metadata,
      version: (current.version ?? 1) + 1,
      is_current: true,
    })
    .returning({ id: knowledgeEntries.id });
  if (docEmbedding) await setKnowledgeEmbedding(row!.id, docEmbedding);

  return { action: "updated", id: row!.id };
}

/** Set the doc-level embedding column on a knowledge_entries row (hybrid search). */
async function setKnowledgeEmbedding(id: string, embedding: number[]): Promise<void> {
  const db = getDb();
  await db.execute(
    sql`UPDATE knowledge_entries SET embedding = ${toVector(embedding)}::vector WHERE id = ${id}`,
  );
}

/**
 * Refresh a single source's chunks in the turicks_brain vector table.
 * Idempotent: deletes any existing chunks for this source_path, then inserts
 * freshly-embedded chunks. This is the store search_turicks_brain queries.
 */
async function syncVectorChunks(entry: DocEntry): Promise<number> {
  const db = getDb();
  const chunks = chunkText(entry.content);
  if (chunks.length === 0) return 0;

  const embeddings = await embedTexts(chunks);

  // Remove prior chunks for this source (idempotent re-run).
  await db.execute(
    sql`DELETE FROM turicks_brain WHERE metadata->>'source_path' = ${entry.source}`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const metadata = {
      source_path: entry.source,
      title: entry.title,
      entry_type: entry.entry_type,
      tags: entry.tags,
      chunk_index: i,
      chunk_count: chunks.length,
    };
    await db.execute(sql`
      INSERT INTO turicks_brain (content, metadata, embedding)
      VALUES (${chunks[i]!}, ${JSON.stringify(metadata)}::jsonb, ${toVector(embeddings[i]!)}::vector)
    `);
  }
  return chunks.length;
}

/**
 * Delete stale rows whose source is no longer in the current doc manifest.
 * Per-source refresh (syncVectorChunks) only touches sources it currently sees,
 * so a doc that is deleted/renamed out of docs/ leaves its chunks behind forever
 * (the "orphaned chunk" class — stale content can still surface in retrieval).
 * This makes the sync self-healing: after every run the stores hold exactly the
 * current doc set and nothing more.
 *
 * Safety: no-op if currentSources is empty (never wipe the whole store).
 * Returns { chunks, entries } counts removed.
 */
async function pruneOrphans(
  currentSources: string[],
): Promise<{ chunks: number; entries: number }> {
  if (currentSources.length === 0) return { chunks: 0, entries: 0 };
  const db = getDb();
  const sourceList = sql.join(
    currentSources.map((s) => sql`${s}`),
    sql`, `,
  );

  // Vector store: drop chunks whose source_path is not a current doc.
  const chunkRes = await db.execute(
    sql`DELETE FROM turicks_brain WHERE metadata->>'source_path' NOT IN (${sourceList})`,
  );

  // Keyword store: retire current rows whose source is not a current doc
  // (versioned table — mark is_current=false rather than hard-delete).
  const entryRes = await db.execute(
    sql`UPDATE knowledge_entries SET is_current = false
        WHERE tenant_id = 'turicks' AND is_current = true
          AND source NOT IN (${sourceList})`,
  );

  // postgres.js RowList exposes affected-row count as `.count` (not `.rowCount`).
  return {
    chunks: (chunkRes as unknown as { count?: number }).count ?? 0,
    entries: (entryRes as unknown as { count?: number }).count ?? 0,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const keywordOnly = process.argv.includes("--keyword-only");

  if (keywordOnly) {
    console.log(
      "🧠 Syncing docs to knowledge_entries (keyword-only — no Ollama, no turicks_brain vectors)…\n",
    );
  } else {
    console.log("🧠 Syncing docs to turicks-brain (knowledge_entries + turicks_brain vectors)…\n");

    // Fail loud + early if Ollama can't embed — otherwise we'd write keyword rows
    // with no vectors and the vector search would silently stay empty (the exact
    // production bug this rewrite fixes). One cheap probe before the loop.
    try {
      await embedText("connectivity probe");
    } catch (err) {
      console.error(
        `❌ Ollama embeddings unavailable — aborting before any write.\n   ${(err as Error).message}\n` +
          `   Start Ollama and pull the embed model, then re-run:  ollama pull nomic-embed-text\n` +
          `   Or use keyword-only (no vectors):  node --import tsx/esm scripts/sync-turicks-brain.ts --keyword-only`,
      );
      process.exit(1);
    }
  }

  const docs = collectDocs(".");
  console.log(`Found ${docs.length} documents to sync.\n`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let totalChunks = 0;
  let failures = 0;

  for (const doc of docs) {
    try {
      const docEmbedding = keywordOnly
        ? null
        : await embedText(`${doc.title}\n\n${doc.content.slice(0, 4000)}`);
      const { action } = await upsertEntry(doc, docEmbedding);

      let chunks = 0;
      if (!keywordOnly) {
        chunks = await syncVectorChunks(doc);
        totalChunks += chunks;
      }

      const icon = action === "inserted" ? "✅" : action === "updated" ? "🔄" : "—";
      console.log(
        `${icon} [${action}] ${doc.entry_type}: ${doc.title}` +
          (keywordOnly ? "" : `  (${chunks} chunks)`),
      );
      if (action === "inserted") inserted++;
      else if (action === "updated") updated++;
      else skipped++;
    } catch (err) {
      failures++;
      console.error(`❌ Failed: ${doc.title} — ${(err as Error).message}`);
    }
  }

  const pruned = await pruneOrphans(docs.map((d) => d.source));
  if (pruned.chunks > 0 || pruned.entries > 0) {
    console.log(
      `\n🧹 Pruned orphans: ${pruned.chunks} stale chunks removed from turicks_brain, ` +
        `${pruned.entries} stale knowledge_entries retired.`,
    );
  }

  console.log(
    `\n✅ Sync complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped` +
      (keywordOnly ? " (keyword-only)" : ` · ${totalChunks} vector chunks embedded into turicks_brain`) +
      (failures > 0 ? ` · ${failures} FAILED` : ""),
  );
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
