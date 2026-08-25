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
 *   - turicks_brain: per-source refresh (delete this source's chunks, re-insert),
 *     SKIPPED entirely when every chunk already carries this content's sha256.
 *
 * Requires: Ollama running with nomic-embed-text pulled, Postgres + pgvector up.
 *
 * Required env (loaded from .env in cwd — see scripts/lib/require-env.ts):
 *   DATABASE_URL   PostgreSQL connection string (.env.example has the local-dev
 *                  default; ask the founder for the prod value — never commit it).
 * Missing .env, or DATABASE_URL unset within it, exits(1) with a named-variable
 * message instead of the bare `node: .env: not found` this used to throw.
 */

// MUST be the first import — see scripts/lib/require-env.ts for why (it exits
// before ../src/db/client.js's eager env parse can throw an opaque error).
import "./lib/require-env.js";

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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

/**
 * Fingerprint of a doc's content, stored on every chunk it produces. This is the
 * key that lets an unchanged doc skip re-embedding on the next sync.
 */
export function contentSha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Whether a source's vector chunks must be re-embedded, given how many rows
 * already carry this content's sha and how many chunks the content produces.
 *
 * Until 2026-08-12 every sync re-embedded every chunk of every doc, changed or
 * not. Ollama on the VPS serializes embeds at ~1.1s each, so a no-op sync cost
 * ~555 round trips (~10 min) — which is what blew the deploy's 10-minute SSH
 * budget and killed the remote script mid-flight.
 *
 * A PARTIAL match must still refresh: a run killed mid-insert leaves fewer rows
 * than the content expects, and calling that current would pin a truncated doc
 * in retrieval forever.
 */
export function needsChunkRefresh(matchingChunks: number, expectedChunks: number): boolean {
  if (expectedChunks === 0) return false;
  return matchingChunks !== expectedChunks;
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

/**
 * Sections that are banner-marked "DO NOT FOLLOW" in the doc but must NEVER be
 * chunked into the brain.
 *
 * A reader sees the banner at the top of the file; a retrieved CHUNK does not.
 * chunkText splits at 1800 chars, so DEVELOPER.md's warning (lines 7–23) lands in
 * chunk 0 while the v2 procedure it warns about lands in chunks 7–13 — an agent
 * asking "how do I add a department" would get `createSupervisor` steps and
 * `src/agents/office.ts`, a CI tombstone whose re-creation fails `pnpm verify:arch`.
 * Ingesting these verbatim would undo the 2026-08-09 correction in the one channel
 * agents actually read from, while `brain:sync` still printed ✅.
 *
 * Remove an entry here in the same commit that rewrites the section to v3.
 */
export const STALE_SECTIONS: Record<string, readonly string[]> = {
  "docs/DEVELOPER.md": [
    "## Adding a Department",
    "## Adding a Domain (nested sub-supervisor)",
    "## Adding a Workflow (SOP)",
  ],
  "docs/rules/PROGRAMMING-RULES.md": [
    "## Wiring Map 2 — Add a Department",
    "## Wiring Map 3 — Add a Workflow (SOP)",
  ],
};

/**
 * Drop each named section (heading → next heading of the same or higher level),
 * leaving a one-line marker so a retrieved neighbouring chunk still shows that
 * something was deliberately withheld rather than never written.
 *
 * Throws when a listed heading is absent: a rename must fail the sync loudly, not
 * silently re-admit v2 procedure into retrieval.
 */
export function stripStaleSections(content: string, source: string): string {
  const headings = STALE_SECTIONS[source];
  if (!headings) return content;

  const lines = content.split("\n");
  const dropped = new Set<number>();

  for (const heading of headings) {
    const start = lines.findIndex((l) => l.trim() === heading);
    if (start === -1) {
      throw new Error(
        `${source}: stale-section heading "${heading}" not found. If it was rewritten ` +
          `to v3, delete it from STALE_SECTIONS in this file; if it was renamed, update it there.`,
      );
    }
    const level = (lines[start]!.match(/^#+/) ?? ["#"])[0].length;
    let end = start + 1;
    while (end < lines.length && !new RegExp(`^#{1,${level}}\\s`).test(lines[end]!)) end++;
    for (let i = start + 1; i < end; i++) dropped.add(i);
  }

  return lines
    .map((line, i) => {
      if (!dropped.has(i)) return line;
      return dropped.has(i - 1) ? null : "_(v2 procedure — withheld from retrieval; see the banner in this file.)_";
    })
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Directories synced wholesale — every top-level `.md` file in each becomes a
 * `plan` knowledge entry. CLAUDE.md's "Cross-Agent Awareness" rule tells every
 * agent to check recent plans before starting work, so a doc landing here must
 * actually reach `brain:sync`'s output, not just this source tree.
 *
 * Until 2026-08-08 neither directory was on this allowlist (see the comment at
 * the loop below) — `brain:sync` reported success while ingesting zero plans.
 */
export const PLAN_SYNC_DIRS = ["docs/plans", "docs/product-recovery"] as const;

/**
 * True when `sourcePath` (repo-root-relative, e.g. "docs/plans/foo.md") is a
 * direct `.md` child of one of PLAN_SYNC_DIRS — i.e. the next `brain:sync` run
 * will pick it up. Pure and exported so a unit test can pin the allowlist
 * without a live Postgres/Ollama (see tests/unit/scripts/sync-turicks-brain.test.ts).
 *
 * Mirrors collectDocs' actual scan below: readdirSync is non-recursive, so a
 * file nested one directory deeper (e.g. "docs/plans/sub/foo.md") is correctly
 * NOT picked up — matched here too, not just filtered by prefix.
 */
export function isPlanSyncSource(sourcePath: string): boolean {
  return PLAN_SYNC_DIRS.some((dir) => {
    const rest = sourcePath.startsWith(`${dir}/`) ? sourcePath.slice(dir.length + 1) : null;
    return rest !== null && rest.endsWith(".md") && !rest.includes("/");
  });
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

  // ── Market Intelligence ─────────────────────────────────────────────────────
  const marketIntelDir = join(root, "docs/market-intel");
  if (existsSync(marketIntelDir)) {
    for (const file of readdirSync(marketIntelDir).filter((f) => f.endsWith(".md") && f !== "README.md")) {
      const content = readFile(join(marketIntelDir, file));
      docs.push({
        entry_type: "market_intel",
        title: titleFromFilename(file),
        content,
        source: `docs/market-intel/${file}`,
        tags: ["market", "competitor", "intelligence", "strategy"],
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

  // ── Engineering rules + the developer guide ─────────────────────────────────
  // Precedence layer 4 (CLAUDE.md): these are what an agent follows to add a tool
  // or a department. Until 2026-08-09 they were the only agent-facing docs absent
  // from this manifest, so the brain could answer "what did we decide" but not
  // "how do I do it" — the 2026-08-09 corrections were invisible to retrieval.
  // Known-stale sections are withheld by STALE_SECTIONS above, not ingested raw.
  const rulesDir = join(root, "docs/rules");
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).filter((f) => f.endsWith(".md"))) {
      const source = `docs/rules/${f}`;
      docs.push({
        entry_type: "rule",
        title: titleFromFilename(f),
        content: stripStaleSections(readFile(join(rulesDir, f)), source),
        source,
        tags: ["rule", "procedure", "engineering", "how-to"],
      });
    }
  }

  const developerGuide = join(root, "docs/DEVELOPER.md");
  if (existsSync(developerGuide)) {
    docs.push({
      entry_type: "rule",
      title: "FounderOS Developer Guide",
      content: stripStaleSections(readFile(developerGuide), "docs/DEVELOPER.md"),
      source: "docs/DEVELOPER.md",
      tags: ["rule", "procedure", "engineering", "how-to", "onboarding"],
    });
  }

  // ── Implementation plans + the product-recovery program ─────────────────────
  // CLAUDE.md tells every agent to query the brain for recent plans before
  // starting work. Until 2026-08-08 neither directory was on this allowlist, so
  // `brain:sync` reported "inserted / updated / ✅ complete" while ingesting
  // ZERO plans — a green mechanism with the outcome missing, which is the same
  // failure shape the product-recovery audit was opened to fix.
  for (const dir of PLAN_SYNC_DIRS) {
    const planDir = join(root, dir);
    if (!existsSync(planDir)) continue;
    for (const f of readdirSync(planDir).filter((f) => isPlanSyncSource(`${dir}/${f}`))) {
      docs.push({
        entry_type: "plan",
        title: titleFromFilename(f),
        content: readFile(join(planDir, f)),
        source: `${dir}/${f}`,
        tags: ["plan", "implementation", dir.replace("docs/", "")],
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

  // ── Session Logs (Episodic Memory) ─────────────────────────────────────────
  const sessionsDir = join(root, "docs/sessions");
  if (existsSync(sessionsDir)) {
    for (const file of readdirSync(sessionsDir).filter((f) => f.endsWith(".md"))) {
      const content = readFile(join(sessionsDir, file));
      docs.push({
        entry_type: "session",
        title: titleFromFilename(file),
        content,
        source: `docs/sessions/${file}`,
        tags: ["session", "episodic-memory", "metrics"],
      });
    }
  }

  return docs;
}

// ── Upsert logic ──────────────────────────────────────────────────────────────

async function upsertEntry(
  entry: DocEntry,
  /** Lazy: called ONLY when a row actually needs a doc-level vector written.
   *  Eagerly embedding here cost one Ollama round trip per doc per sync even
   *  when the row was unchanged and already had a vector. */
  embedDoc: (() => Promise<number[]>) | null,
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
    if (embedDoc) await setKnowledgeEmbedding(row!.id, await embedDoc());
    return { action: "inserted", id: row!.id };
  }

  const current = existing[0]!;
  if (current.content === entry.content) {
    // Unchanged row: only embed if the vector is actually missing (a sync that
    // died before this column was written, or a keyword-only run).
    if (embedDoc && current.embedding === null) {
      await setKnowledgeEmbedding(current.id, await embedDoc());
    }
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
  if (embedDoc) await setKnowledgeEmbedding(row!.id, await embedDoc());

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
 *
 * Cheap when nothing changed: one COUNT query decides. Every chunk carries the
 * sha256 of the doc it came from, so "all expected chunks already present with
 * this sha" ⇒ nothing to do, and the (chunks + 1) Ollama round trips are skipped.
 */
async function syncVectorChunks(entry: DocEntry): Promise<{ chunks: number; refreshed: boolean }> {
  const db = getDb();
  const chunks = chunkText(entry.content);
  if (chunks.length === 0) return { chunks: 0, refreshed: false };

  const sha = contentSha(entry.content);
  const counted = await db.execute(sql`
    SELECT count(*)::int AS n FROM brain.turicks_brain
    WHERE metadata->>'source_path' = ${entry.source}
      AND metadata->>'content_sha' = ${sha}
  `);
  const matching = Number((counted[0] as { n: number | string } | undefined)?.n ?? 0);
  if (!needsChunkRefresh(matching, chunks.length)) {
    return { chunks: chunks.length, refreshed: false };
  }

  const embeddings = await embedTexts(chunks);

  // Remove prior chunks for this source (idempotent re-run).
  await db.execute(
    sql`DELETE FROM brain.turicks_brain WHERE metadata->>'source_path' = ${entry.source}`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const metadata = {
      source_path: entry.source,
      title: entry.title,
      entry_type: entry.entry_type,
      tags: entry.tags,
      chunk_index: i,
      chunk_count: chunks.length,
      content_sha: sha,
    };
    await db.execute(sql`
      INSERT INTO brain.turicks_brain (content, metadata, embedding)
      VALUES (${chunks[i]!}, ${JSON.stringify(metadata)}::jsonb, ${toVector(embeddings[i]!)}::vector)
    `);
  }
  return { chunks: chunks.length, refreshed: true };
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
  let currentDocs = 0;
  let failures = 0;

  for (const doc of docs) {
    try {
      const embedDoc = keywordOnly
        ? null
        : () => embedText(`${doc.title}\n\n${doc.content.slice(0, 4000)}`);
      const { action } = await upsertEntry(doc, embedDoc);

      let chunks = 0;
      let refreshed = false;
      if (!keywordOnly) {
        ({ chunks, refreshed } = await syncVectorChunks(doc));
        if (refreshed) totalChunks += chunks;
        else currentDocs++;
      }

      const icon = action === "inserted" ? "✅" : action === "updated" ? "🔄" : "—";
      console.log(
        `${icon} [${action}] ${doc.entry_type}: ${doc.title}` +
          (keywordOnly ? "" : `  (${chunks} chunks${refreshed ? " embedded" : " already current"})`),
      );
      if (action === "inserted") inserted++;
      else if (action === "updated") updated++;
      else skipped++;
    } catch (err) {
      failures++;
      console.error(`❌ Failed: ${doc.title}`, err);
    }
  }

  console.log(
    `\n✅ Sync complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped` +
      (keywordOnly
        ? " (keyword-only)"
        : ` · ${totalChunks} vector chunks embedded into turicks_brain` +
          ` · ${currentDocs} docs already current (no embedding needed)`) +
      (failures > 0 ? ` · ${failures} FAILED` : ""),
  );
  process.exit(failures > 0 ? 1 : 0);
}

// Run only as a CLI — the pure helpers above are imported by unit tests, and an
// import must never start a sync (same guard as scripts/verify-architecture.ts).
if (process.argv[1]?.endsWith("sync-turicks-brain.ts")) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
