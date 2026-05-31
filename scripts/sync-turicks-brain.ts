/**
 * sync-turicks-brain.ts
 * =====================
 * Reads all docs (ADRs, brand guidelines, phase docs, strategic vision, case study)
 * and upserts them into the turicks-brain knowledge_entries table.
 *
 * Run after any architectural decision, brand update, or phase completion:
 *   npx tsx scripts/sync-turicks-brain.ts
 *
 * Idempotent — uses title as upsert key; increments version on content change.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { getDb } from "../src/db/client.js";
import { knowledgeEntries } from "../src/db/schema.js";
import { eq, and } from "drizzle-orm";

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

  // ── Case Study Log ──────────────────────────────────────────────────────────
  const caseStudy = join(root, "docs/study/CASE-STUDY-LOG.md");
  if (existsSync(caseStudy)) {
    docs.push({
      entry_type: "case_study",
      title: "Turicks / FounderOS Case Study Log",
      content: readFile(caseStudy),
      source: "docs/study/CASE-STUDY-LOG.md",
      tags: ["case-study", "milestones", "metrics", "timeline"],
    });
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

  return docs;
}

// ── Upsert logic ──────────────────────────────────────────────────────────────

async function upsertEntry(entry: DocEntry): Promise<{ action: "inserted" | "updated" | "skipped" }> {
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
    await db.insert(knowledgeEntries).values({
      tenant_id: "turicks",
      entry_type: entry.entry_type,
      title: entry.title,
      content: entry.content,
      source: entry.source,
      tags: entry.tags,
      metadata: entry.metadata,
      version: 1,
      is_current: true,
    });
    return { action: "inserted" };
  }

  const current = existing[0]!;
  if (current.content === entry.content) {
    return { action: "skipped" }; // no change
  }

  // Content changed — mark old as non-current, insert new version
  await db
    .update(knowledgeEntries)
    .set({ is_current: false })
    .where(eq(knowledgeEntries.id, current.id));

  await db.insert(knowledgeEntries).values({
    tenant_id: "turicks",
    entry_type: entry.entry_type,
    title: entry.title,
    content: entry.content,
    source: entry.source,
    tags: entry.tags,
    metadata: entry.metadata,
    version: (current.version ?? 1) + 1,
    is_current: true,
  });

  return { action: "updated" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🧠 Syncing docs to turicks-brain (knowledge_entries)…\n");

  const docs = collectDocs(".");
  console.log(`Found ${docs.length} documents to sync.\n`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const doc of docs) {
    try {
      const { action } = await upsertEntry(doc);
      const icon = action === "inserted" ? "✅" : action === "updated" ? "🔄" : "—";
      console.log(`${icon} [${action}] ${doc.entry_type}: ${doc.title}`);
      if (action === "inserted") inserted++;
      else if (action === "updated") updated++;
      else skipped++;
    } catch (err) {
      console.error(`❌ Failed: ${doc.title} — ${(err as Error).message}`);
    }
  }

  console.log(`\n✅ Sync complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
