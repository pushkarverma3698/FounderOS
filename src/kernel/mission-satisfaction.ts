/**
 * FounderOS v3 kernel — Mission-Level Satisfaction Gate (Phase 4 — T3)
 * =====================================================================
 * Asserts whether a completed set of step results genuinely satisfies the mission's goal.
 * Pure function: goal + steps + results → satisfaction verdict.
 * Prevents partial completions (e.g., 3 of 39 rows delivered) from claiming "Mission complete".
 */

import type { StepResult, TaskEnvelope } from "./contracts.js";

export interface MissionSatisfactionVerdict {
  readonly ok: boolean;
  readonly unmet?: readonly string[];
}

/** "500 jobs", "200 most recent applications" — a number bound to a countable noun. */
const REQUESTED_QUANTITY =
  /\b(\d{1,6})\s+(?:most recent\s+|latest\s+|recent\s+|top\s+)?(jobs?|rows?|records?|entries|items|applications?|leads?|results?|emails?)\b/;

/**
 * A format the founder wants PRODUCED. The indefinite article is the whole
 * discriminator: "give me a pdf" asks for one, "summarize the pdf" points at one
 * that already exists.
 */
const REQUESTED_FORMAT =
  /\b(?:as\s+(?:an?\s+)?|into\s+(?:an?\s+)?|in\s+|an?\s+)(pdf|csv|xlsx|excel|docx|word|markdown|md|json|txt|text)\b/;

const FORMAT_ALIASES: Readonly<Record<string, string>> = {
  excel: "xlsx",
  word: "docx",
  markdown: "md",
  text: "txt",
};

function normalizeFormat(raw: string): string {
  return FORMAT_ALIASES[raw] ?? raw;
}

/** Extension from a `<path>:<bytes>` file-evidence string, lowercased, no dot. */
function extensionOf(evidence: string): string | undefined {
  const pathPart = evidence.slice(0, evidence.lastIndexOf(":"));
  const match = /\.([a-z0-9]+)$/i.exec(pathPart);
  return match?.[1]?.toLowerCase();
}

export function missionSatisfied(
  goal: string,
  _steps: readonly TaskEnvelope[],
  results: readonly StepResult[],
): MissionSatisfactionVerdict {
  const unmet: string[] = [];

  // 1. Assert no step failed
  for (const r of results) {
    if (r.status === "failed") {
      unmet.push(`Step '${r.step_id}' failed: ${r.failure.message}`);
    }
  }

  // 2. Check record count completeness when user asks for "all" records/jobs
  const goalLower = goal.toLowerCase();
  const asksForAll =
    goalLower.includes("all jobs") ||
    goalLower.includes("list all") ||
    goalLower.includes("every job") ||
    goalLower.includes("export all");

  if (asksForAll) {
    for (const r of results) {
      if (r.status === "ok" && r.observed?.kind === "record") {
        const mCount = /count:(\d+)/.exec(r.observed.evidence);
        const mTotal = /total:(\d+)/.exec(r.observed.evidence);
        if (mCount && mTotal) {
          const count = parseInt(mCount[1]!, 10);
          const total = parseInt(mTotal[1]!, 10);
          if (total > count) {
            unmet.push(`Requested all records, but delivered ${count} of ${total} total records.`);
          }
        }
      }
    }
  }

  // 3. Reconcile an explicit quantity against what actually exists.
  //    Reality Benchmark D4: "give me 500 jobs" against a 297-row pipeline
  //    produced 297 rows and never said so. Silence there reads as "here are
  //    your 500" — the founder cannot tell a capped result from a small market.
  const askedFor = REQUESTED_QUANTITY.exec(goalLower);
  if (askedFor) {
    const requested = parseInt(askedFor[1]!, 10);
    const noun = askedFor[2]!;
    for (const r of results) {
      if (r.status === "ok" && r.observed?.kind === "record") {
        const mTotal = /total:(\d+)/.exec(r.observed.evidence);
        if (mTotal) {
          const total = parseInt(mTotal[1]!, 10);
          if (requested > total) {
            unmet.push(`Asked for ${requested} ${noun}, but only ${total} exist — the reply must state that difference.`);
          }
        }
      }
    }
  }

  // 4. Catch a silent format substitution.
  //    Reality Benchmark D3: "give me a pdf" produced a .md and offered to send
  //    it without naming the swap. Indefinite article only ("a pdf") — "the pdf"
  //    refers to a file the founder already has, and is not a request to produce one.
  const wantedFormat = REQUESTED_FORMAT.exec(goalLower);
  if (wantedFormat) {
    const wanted = normalizeFormat(wantedFormat[1]!);
    for (const r of results) {
      if (r.status === "ok" && r.observed?.kind === "file") {
        const produced = extensionOf(r.observed.evidence);
        if (produced && produced !== wanted) {
          unmet.push(`Asked for a ${wanted.toUpperCase()} but a ${produced.toUpperCase()} was produced — the reply must say so rather than offer the substitute silently.`);
        }
      }
    }
  }

  // 5. Check delivery assertion when user asks to "send" or "deliver" an attachment/file
  const asksForDelivery =
    goalLower.includes("send me") ||
    goalLower.includes("deliver") ||
    goalLower.includes("attach") ||
    goalLower.includes("send to telegram");

  if (asksForDelivery) {
    const hasDelivery = results.some(
      (r) => r.status === "ok" && (r.observed?.kind === "message" || JSON.stringify(r.output).includes("delivered")),
    );
    if (!hasDelivery) {
      unmet.push("Delivery requested, but no file delivery attachment step succeeded.");
    }
  }

  return unmet.length > 0 ? { ok: false, unmet } : { ok: true };
}
