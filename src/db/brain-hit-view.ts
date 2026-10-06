/**
 * Brain hit presentation: provenance header and the "no strong match" abstain (AG-025).
 * =====================================================================================
 * Two readers print brain_memories hits: the Telegram worker tool (renderRagSuccess) and the IDE MCP hub
 * (src/mcp/brain-tools.ts). Both go through here so a hit reads the same everywhere.
 *
 * Header: `<YYYY-MM-DD> · <origin> · <project or "no project"> · <type>`.
 *
 * Abstain: decided on COSINE similarity only. Hybrid search (src/db/rag-hybrid.ts) fuses by RRF, which is
 * rank-relative: rank 1 always scores high, even for a question the corpus cannot answer. hybridRagSearch returns
 * the first-seen item of each fused document, so a hit that came through the vector leg carries its cosine in
 * `RagHit.cosine`, and a keyword-only hit has none (its `score` is the term-overlap fraction, not comparable).
 * No hit with a cosine (keyword-only fallback, RAGFlow) means we cannot tell, so we never abstain on it.
 */
import type { RagHit } from "./rag-search.js";

/**
 * Best cosine below this → "No strong match". NOT CALIBRATED against the prod corpus: `pnpm eval:retrieval` needs
 * the VPS database and Ollama, neither reachable when this was written. 0.55 is a deliberately low starting value
 * (nomic-embed-text scores unrelated text roughly 0.4 to 0.6), so it abstains only on clearly empty matches and
 * leans toward showing the hit. Calibrate with the no-answer cases in src/eval/retrieval-no-answer.ts: raise it to
 * the highest value that keeps every golden hit above it.
 */
export const BRAIN_ABSTAIN_SIMILARITY = 0.55;

/** At most this many hits are listed under an abstain. */
const ABSTAIN_LIST_MAX = 2;

/** Where the row came from: metadata.origin, else docs (a synced file), agent (ide_mcp), else the raw source. */
export function hitOrigin(hit: RagHit): string {
  const origin = hit.metadata["origin"];
  if (typeof origin === "string" && origin.length > 0) return origin;
  if (typeof hit.metadata["source_path"] === "string") return "docs";
  if (hit.source === "ide_mcp") return "agent";
  return hit.source && hit.source.length > 0 ? hit.source : "unknown origin";
}

function hitDate(hit: RagHit): string {
  const raw = hit.created_at;
  if (raw === undefined || raw === null) return "unknown date";
  const d = raw instanceof Date ? raw : new Date(raw);
  return Number.isNaN(d.getTime()) ? "unknown date" : d.toISOString().slice(0, 10);
}

/** True for a hit read from brain_memories (the only table that selects type, project and created_at). */
export function isBrainHit(hit: RagHit): boolean {
  return hit.memory_type !== undefined;
}

export function hitHeader(hit: RagHit): string {
  return [hitDate(hit), hitOrigin(hit), hit.project ?? "no project", hit.memory_type ?? "unknown type"].join(" · ");
}

/** Highest cosine among the hits that carry one, or null when none does. */
export function bestCosine(hits: readonly RagHit[]): number | null {
  let best: number | null = null;
  for (const h of hits) if (typeof h.cosine === "number" && (best === null || h.cosine > best)) best = h.cosine;
  return best;
}

/**
 * The abstain text when the best cosine is under BRAIN_ABSTAIN_SIMILARITY, else null. It names the closest hit and
 * lists at most two, so the founder still sees what was nearest, labelled as weak.
 */
export function abstainText(
  hits: readonly RagHit[],
  query: string,
  renderOne: (hit: RagHit, index: number) => string,
): string | null {
  const best = bestCosine(hits);
  if (best === null || best >= BRAIN_ABSTAIN_SIMILARITY || !hits.every(isBrainHit)) return null;
  const closest = hits.find((h) => h.cosine === best)!;
  return (
    `No strong match for "${query}". Closest: ${hitHeader(closest)} (similarity ${best.toFixed(2)})\n\n` +
    hits.slice(0, ABSTAIN_LIST_MAX).map(renderOne).join("\n\n")
  );
}

/** `renderOne` over every hit, or the abstain when the best cosine is weak. */
export function renderWithAbstain(
  hits: readonly RagHit[],
  query: string,
  renderOne: (hit: RagHit, index: number) => string,
): string {
  return abstainText(hits, query, renderOne) ?? hits.map(renderOne).join("\n\n");
}
