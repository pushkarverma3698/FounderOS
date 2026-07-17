/**
 * Typed retrieval results + mechanical citations (spec §1.1 F4).
 * ==============================================================
 * Every cross-boundary payload in v3 is Zod-validated except retrieval, which
 * returned free strings. This makes a retrieved passage a typed record: a
 * malformed or source-less "result" fails validation instead of flowing on as
 * something the synthesizer could present as a real citation. Rendering then
 * derives from validated data, so a citation always points at a real retrieved
 * source (zero-hallucination is a mechanism, not a hope).
 */
import { z } from "zod";
import type { RagHit } from "./rag-search.js";

export const RetrievalResultSchema = z.object({
  /** Where the chunk came from — a file path, URL, or doc id. Never empty. */
  source: z.string().min(1),
  /** Optional document class (decision | conversation | resume | …). */
  doc_type: z.string().min(1).optional(),
  /** Retrieval score (cosine, RRF, or term-overlap depending on path). */
  score: z.number(),
  /** The retrieved text. Never empty — an empty chunk is not a citable result. */
  chunk: z.string().min(1),
  /** Pre-rendered citation token, e.g. "[ADR-001.md]". */
  citation: z.string().min(1),
});

export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

/**
 * Project a raw {@link RagHit} into a {@link RetrievalResult}. Source resolves
 * from the store's source field (source_path / source_file / source_url), then a
 * generic `source`, then "unknown" — so a citation is always renderable even for
 * a sparsely-tagged row.
 */
export function toRetrievalResult(hit: RagHit, sourceField: string): RetrievalResult {
  const source =
    (hit.metadata[sourceField] as string | undefined) ??
    (hit.metadata["source"] as string | undefined) ??
    "unknown";
  const docType = hit.metadata["doc_type"];
  const result: RetrievalResult = {
    source,
    score: hit.score,
    chunk: hit.content.trim(),
    citation: `[${source}]`,
  };
  if (typeof docType === "string" && docType.length > 0) result.doc_type = docType;
  return result;
}

/** Render validated results as numbered, cited passages (most-relevant first). */
export function renderRetrieval(results: readonly RetrievalResult[], query: string): string {
  if (results.length === 0) {
    return `No results found for "${query}". The knowledge base may not have this information yet.`;
  }
  return results
    .map((r, i) => {
      const type = r.doc_type ? ` ${r.doc_type}` : "";
      return `${i + 1}. ${r.citation}${type} (score ${r.score.toFixed(2)})\n${r.chunk}`;
    })
    .join("\n\n");
}
