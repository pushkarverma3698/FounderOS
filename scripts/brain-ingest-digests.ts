/**
 * FounderOS: VPS side of the Mac capture (AG-027). Reads JSONL digests on stdin, validates each with Zod, re-scrubs,
 * writes through `brainIngest` (upsert on source + source_id), archives memory rows whose file left the manifest,
 * caps at 200 records per run and prints one summary line.
 *
 *   ssh founderos-vps 'cd /opt/founderos && node --env-file=.env --import tsx/esm scripts/brain-ingest-digests.ts' < digests.jsonl
 *
 * Exit 1 when any record failed to write, so the Mac keeps its old state and retries the batch next run.
 */
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { brainMemories } from "../src/db/schema.js";
import { brainIngest, type IngestOptions } from "../src/db/brain-ingest.js";
import { brainProvenanceSchema } from "../src/db/brain-provenance.js";
import { MAX_RECORDS_PER_RUN, parseDigestInput, type DigestRecord, type ManifestRecord } from "../src/lib/brain-digest.js";

export interface IngestDeps {
  readonly ingest: (opts: IngestOptions) => Promise<{ outcome: "inserted" | "updated" | "unchanged" }>;
  /** Archives memory rows of the manifest's slug that are not listed, reactivates listed ones. Returns rows archived. */
  readonly archive: (manifest: ManifestRecord) => Promise<number>;
}

export interface IngestSummary {
  readonly ingested: number;
  readonly skipped: number;
  readonly archived: number;
  readonly droppedForSecrets: number;
  readonly failed: number;
  readonly dropped: readonly string[];
}

/** Provenance fields go in `provenance`; everything else (title, branch, slug, file) stays in `metadata`. */
export function toIngestOptions(r: DigestRecord): IngestOptions {
  const provenance = brainProvenanceSchema.parse(r.metadata);
  const { origin: _o, client: _c, machine: _m, session_id: _s, repo: _r, occurred_at: _t, visibility: _v, ...extras } = r.metadata;
  return {
    memoryType: r.memory_type, content: r.content, source: r.source, sourceId: r.source_id,
    ...(r.project ? { project: r.project } : {}), metadata: extras, provenance,
  };
}

export async function ingestDigests(text: string, deps: IngestDeps, cap: number = MAX_RECORDS_PER_RUN): Promise<IngestSummary> {
  const parsed = parseDigestInput(text, cap);
  let ingested = 0;
  let unchanged = 0;
  let failed = 0;
  for (const record of parsed.records) {
    try {
      const { outcome } = await deps.ingest(toIngestOptions(record));
      if (outcome === "unchanged") unchanged += 1;
      else ingested += 1;
    } catch (err) {
      failed += 1;
      console.error(`ingest failed for ${record.source}:${record.source_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let archived = 0;
  // A failed batch must not archive: the manifest may describe files whose rows were never written.
  if (failed === 0) for (const m of parsed.manifests) archived += await deps.archive(m);
  return {
    ingested, skipped: unchanged + parsed.invalid + parsed.overCap, archived,
    droppedForSecrets: parsed.dropped.length, failed, dropped: parsed.dropped,
  };
}

export const summaryText = (s: IngestSummary): string =>
  `ingested ${s.ingested}, skipped ${s.skipped}, archived ${s.archived}, dropped-for-secrets ${s.droppedForSecrets}` +
  (s.failed > 0 ? `, FAILED ${s.failed}` : "");

const memoryRows = (slug: string) =>
  and(eq(brainMemories.source, "mac-claude"), eq(brainMemories.memory_type, "claude_memory"), sql`${brainMemories.metadata}->>'slug' = ${slug}`);

/** An empty id list is a broken capture, not "delete everything": do nothing. */
async function archiveFromManifest(m: ManifestRecord): Promise<number> {
  const ids = m.metadata.source_ids;
  if (ids.length === 0) return 0;
  await db.update(brainMemories).set({ status: "ACTIVE" })
    .where(and(memoryRows(m.metadata.slug), inArray(brainMemories.source_id, ids), eq(brainMemories.status, "ARCHIVED")));
  const gone = await db.update(brainMemories).set({ status: "ARCHIVED", updated_at: new Date() })
    .where(and(memoryRows(m.metadata.slug), notInArray(brainMemories.source_id, ids), sql`${brainMemories.status} <> 'ARCHIVED'`))
    .returning({ id: brainMemories.id });
  return gone.length;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestDigests(await readStdin(), { ingest: brainIngest, archive: archiveFromManifest })
    .then((s) => {
      console.log(summaryText(s));
      for (const d of s.dropped) console.error(`dropped for secrets: ${d}`);
      process.exit(s.failed > 0 ? 1 : 0);
    })
    .catch((err: unknown) => {
      console.error(`brain-ingest-digests failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
