/**
 * FounderOS v3 — ContextComposer Engine
 * =====================================
 * Enforces the 5-layer memory hierarchy and multi-signal ranking for worker prompts.
 */

import { formatGraphContext, type EntityTriple } from "../db/entity-graph.js";

export interface MemoryItem {
  id: string;
  layer: 0 | 1 | 2 | 3 | 4;
  content: string;
  cosineSim?: number;
  confidence?: number;
  timestamp?: number;
  graphRelevance?: number;
}

export interface ComposeContextOptions {
  workingMemoryText: string;
  workspaceStateText?: string;
  recentEvidenceText?: string;
  distilledRagText?: string;
  entityGraphTriples?: EntityTriple[];
  maxTokens?: number;
}

/**
 * Multi-signal relevance score:
 * S = 0.4 * CosineSim + 0.2 * TimeDecay + 0.2 * Confidence + 0.2 * GraphRelevance
 */
export function calculateMultiSignalScore(item: MemoryItem): number {
  const sim = item.cosineSim ?? 0.5;
  const conf = item.confidence ?? 1.0;
  const graphRel = item.graphRelevance ?? 0.5;

  let decay = 1.0;
  if (item.timestamp) {
    const ageHours = (Date.now() - item.timestamp) / (1000 * 60 * 60);
    decay = Math.max(0.1, 1 - ageHours / 72); // 3-day half-life decay
  }

  return 0.4 * sim + 0.2 * decay + 0.2 * conf + 0.2 * graphRel;
}

export function rankMemoryItems(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => calculateMultiSignalScore(b) - calculateMultiSignalScore(a));
}

/**
 * Compose 5-layer context string bounded by target token budget.
 */
export function composeTurnContext(opts: ComposeContextOptions): string {
  const maxTokens = opts.maxTokens ?? 24000;
  const charBudget = maxTokens * 4; // 1 token ~ 4 chars

  const sections: string[] = [];

  // Layer 0: Working Memory
  if (opts.workingMemoryText.trim()) {
    sections.push(`## Layer 0: Current Working Conversation\n${opts.workingMemoryText.trim()}`);
  }

  // Layer 1: Active Workspace State
  if (opts.workspaceStateText?.trim()) {
    sections.push(`## Layer 1: Active Workspace State\n${opts.workspaceStateText.trim()}`);
  }

  // Layer 2: Recent Task Evidence
  if (opts.recentEvidenceText?.trim()) {
    sections.push(`## Layer 2: Recent Execution Evidence\n${opts.recentEvidenceText.trim()}`);
  }

  // Layer 3: Distilled Knowledge & Cognee Entity Graph
  const graphBlock = opts.entityGraphTriples ? formatGraphContext(opts.entityGraphTriples) : "";
  const ragBlock = opts.distilledRagText?.trim() ?? "";
  if (graphBlock || ragBlock) {
    sections.push(`## Layer 3: Distilled Memory & Entity Graph\n${graphBlock}\n${ragBlock}`.trim());
  }

  let fullContext = sections.join("\n\n---\n\n");

  // Truncate to char budget if needed
  if (fullContext.length > charBudget) {
    fullContext = fullContext.slice(0, charBudget) + "\n\n[...Context truncated to fit token budget...]";
  }

  return fullContext;
}
