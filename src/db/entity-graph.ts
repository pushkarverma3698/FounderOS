/**
 * FounderOS — Cognee Entity-Graph Traversal Engine
 * ================================================
 * Pure graph traversal & triple extraction for relationship-aware knowledge RAG.
 */

import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "db:entity-graph" });

export interface EntityNode {
  id: string;
  name: string;
  type: string;
}

export interface EntityTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

/** In-memory graph structure for deterministic fallback & unit testing. */
export class EntityGraphMemory {
  private entities = new Map<string, EntityNode>();
  private triples: EntityTriple[] = [];

  public upsertEntity(name: string, type = "concept"): EntityNode {
    const key = name.toLowerCase().trim();
    const existing = this.entities.get(key);
    if (existing) return existing;

    const node: EntityNode = { id: `node_${this.entities.size + 1}`, name: name.trim(), type };
    this.entities.set(key, node);
    return node;
  }

  public addTriple(subject: string, predicate: string, object: string, confidence = 1.0): void {
    const sNode = this.upsertEntity(subject);
    const oNode = this.upsertEntity(object);

    const exists = this.triples.some(
      (t) =>
        t.subject.toLowerCase() === sNode.name.toLowerCase() &&
        t.predicate.toLowerCase() === predicate.toLowerCase() &&
        t.object.toLowerCase() === oNode.name.toLowerCase(),
    );

    if (!exists) {
      this.triples.push({
        subject: sNode.name,
        predicate: predicate.trim().toLowerCase(),
        object: oNode.name,
        confidence,
      });
    }
  }

  public queryGraph(startEntity: string, maxDepth = 2): EntityTriple[] {
    const rootKey = startEntity.toLowerCase().trim();
    const visited = new Set<string>([rootKey]);
    const results: EntityTriple[] = [];

    let currentFrontier = [rootKey];

    for (let depth = 0; depth < maxDepth; depth++) {
      const nextFrontier: string[] = [];

      for (const entityKey of currentFrontier) {
        for (const triple of this.triples) {
          const sKey = triple.subject.toLowerCase();
          const oKey = triple.object.toLowerCase();

          if (sKey === entityKey) {
            results.push(triple);
            if (!visited.has(oKey)) {
              visited.add(oKey);
              nextFrontier.push(oKey);
            }
          } else if (oKey === entityKey) {
            results.push(triple);
            if (!visited.has(sKey)) {
              visited.add(sKey);
              nextFrontier.push(sKey);
            }
          }
        }
      }

      currentFrontier = nextFrontier;
    }

    return results;
  }
}

export const globalEntityGraph = new EntityGraphMemory();

/**
 * Lightweight heuristic triple extractor for markdown transcripts and notes.
 */
export function extractHeuristicTriples(text: string): EntityTriple[] {
  const triples: EntityTriple[] = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // Match "X requires Y", "X depends on Y", "X uses Y", "X built with Y"
    const match = trimmed.match(/^[-*]?\s*([A-Za-z0-9_.-]+)\s+(requires|uses|depends on|built with|runs on|integrates|targets)\s+([A-Za-z0-9_.-]+)/i);
    if (match) {
      const [, subject, predicate, object] = match;
      if (subject && predicate && object) {
        triples.push({
          subject: subject.trim(),
          predicate: predicate.trim().toLowerCase(),
          object: object.trim(),
          confidence: 0.9,
        });
      }
    }
  }

  return triples;
}

/**
 * Format entity triples into markdown context block for LLM prompts.
 */
export function formatGraphContext(triples: EntityTriple[]): string {
  if (triples.length === 0) return "";

  const lines = triples.map(
    (t) => `• [${t.subject}] ──${t.predicate}──► [${t.object}]`
  );
  return `### Knowledge Entity Graph Relationships\n${lines.join("\n")}`;
}
