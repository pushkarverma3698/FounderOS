/**
 * FounderOS v3 kernel — unbacked-progress guard (AG-034).
 * ======================================================
 * 2026-09-16 (#396): "Antigravity is actively executing in its isolated workspace".
 * No status tool ran, and the next turn showed the task had not started. A present-
 * progress claim about an agent or task is a statement about the world that only a
 * status read can back, so the sentence survives only when one succeeded this turn.
 *
 * Sibling of promise-guard.ts and built the same way: a pure function over the reply
 * text and the step results, sentence-level replacement, byte-for-byte passthrough
 * for lines with no match. No LLM call.
 */

import type { StepResult } from "./contracts.js";

/**
 * Tools whose success means this turn READ the state of an agent, task, PR or log.
 * A receipt records the tool and an args hash, not the action, so any successful
 * github_read counts; the read-only actions (get_pr, list_prs) are what it is used for here.
 */
export const STATUS_TOOLS: ReadonlySet<string> = new Set(["antigravity_task_status", "github_read", "read_logs"]);

/** What the reply says in place of a progress claim nothing checked. */
export const NO_STATUS_NOTICE =
  "I haven't checked its status this turn. Ask \"status of <task>\" and I'll look.";

/** One present-progress phrase and a sentence that must match it (the unit test runs every sample). */
export interface ProgressPhrase {
  readonly pattern: RegExp;
  readonly sample: string;
}

const ADVERBS = "(?:(?:currently|actively|still|now)\\s+)*";

export const PROGRESS_PHRASES: readonly ProgressPhrase[] = [
  { pattern: new RegExp("\\b(?:is|are)\\s+" + ADVERBS + "working\\s+on\\b", "i"), sample: "Antigravity is working on task 76" },
  { pattern: new RegExp("\\b(?:is|are)\\s+" + ADVERBS + "executing\\b", "i"), sample: "Antigravity is actively executing task 76" },
  { pattern: new RegExp("\\b(?:is|are)\\s+" + ADVERBS + "building\\b", "i"), sample: "The agent is building the feature" },
  { pattern: /\bin\s+progress\b/i, sample: "The build is in progress" },
  { pattern: /\b(?:has|have)\s+(?:now\s+)?started\b/i, sample: "The agent has started on it" },
];

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

function claimsProgress(sentence: string): boolean {
  return PROGRESS_PHRASES.some((p) => p.pattern.test(sentence));
}

function hasStatusReceipt(results: readonly StepResult[]): boolean {
  return results.some((r) => r.status === "ok" && r.tool_receipts.some((t) => t.ok && STATUS_TOOLS.has(t.tool)));
}

/** Sentences in `text` that claim present progress, whether or not a receipt backs them. */
export function countProgressClaims(text: string): number {
  return text.split("\n").reduce((n, line) => n + line.split(SENTENCE_BOUNDARY).filter(claimsProgress).length, 0);
}

/**
 * Replace present-progress sentences with NO_STATUS_NOTICE unless a status tool
 * (STATUS_TOOLS) succeeded this turn. The notice appears once per reply; lines with no
 * claim come back byte for byte.
 */
export function stripUnbackedProgress(text: string, results: readonly StepResult[]): string {
  if (hasStatusReceipt(results) || countProgressClaims(text) === 0) return text;
  let noticed = false;
  const kept = text.split("\n").flatMap((line) => {
    if (!line.split(SENTENCE_BOUNDARY).some(claimsProgress)) return [line];
    const sentences = line.split(SENTENCE_BOUNDARY).flatMap((s) => {
      if (!claimsProgress(s)) return [s];
      if (noticed) return [];
      noticed = true;
      return [NO_STATUS_NOTICE];
    });
    return sentences.length === 0 ? [] : [sentences.join(" ")];
  });
  return kept.join("\n").trim();
}
