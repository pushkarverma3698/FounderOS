/**
 * FounderOS v3 kernel — false-promise guard (P2-7, audit F17).
 * ============================================================
 * "Got it! I'll monitor Issue #762 and keep you posted." Nothing in the kernel
 * watches an issue: the only things that can reach the founder later are a
 * scheduled task and a reminder. The sentence was a promise with no mechanism, and
 * the founder asked "why not picked up?" five times because of it.
 *
 * Why code and not a prompt: the synthesizer is an LLM, and "never promise to
 * monitor" is an instruction it can drop under load. The check is a pure function
 * over the reply text and the step results, so a unit test can pin it.
 *
 * A promise survives only when a successful receipt from WATCHER_TOOLS exists.
 */

import type { StepResult } from "./contracts.js";

/** Tools whose success means something WILL notify the founder later. */
export const WATCHER_TOOLS: ReadonlySet<string> = new Set(["schedule_task", "set_reminder"]);

/** What the reply says when the promise was all it said. */
export const NO_WATCHER_NOTICE =
  "Nothing is watching this: no reminder or scheduled task was set. Ask me for an update, or send /where.";

/** Fewest words a clause before the promise needs in order to stand as a sentence on its own. */
const MIN_KEPT_PREFIX_WORDS = 3;

const PROMISE_PATTERN =
  /\bI(?:['’]ll|\s+will|['’]m\s+going\s+to|\s+am\s+going\s+to)\s+(?:\w+\s+){0,2}?(?:monitor|keep\s+(?:you\s+(?:posted|updated|informed)|an\s+eye|tabs|track|watch)|watch|track|let\s+you\s+know|notify\s+you|ping\s+you|update\s+you|report\s+back|check\s+back)\b/i;

/** The conjunction and punctuation that joined a promise clause onto the fact before it. */
const TRAILING_JOINER = /[\s,;:—–-]*(?:\b(?:and|but|so|then)\b)?[\s,;:—–-]*$/i;

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+/;

function hasWatcher(results: readonly StepResult[]): boolean {
  return results.some(
    (r) => r.status === "ok" && r.tool_receipts.some((t) => t.ok && WATCHER_TOOLS.has(t.tool)),
  );
}

/** The sentence without its promise clause, or "" when nothing worth keeping is left. */
function withoutPromise(sentence: string): string {
  const match = PROMISE_PATTERN.exec(sentence);
  if (!match) return sentence;
  const prefix = sentence.slice(0, match.index).replace(TRAILING_JOINER, "");
  const words = prefix.match(/\S+/g)?.length ?? 0;
  if (words < MIN_KEPT_PREFIX_WORDS) return "";
  return /[.!?]$/.test(prefix) ? prefix : `${prefix}.`;
}

function stripLine(line: string): string {
  if (!PROMISE_PATTERN.test(line)) return line;
  return line
    .split(SENTENCE_BOUNDARY)
    .map(withoutPromise)
    .filter((s) => s !== "")
    .join(" ");
}

/**
 * Remove "I'll monitor / keep you posted"-style promises from a founder-facing reply
 * unless a watcher (WATCHER_TOOLS) really ran. Lines without a promise come back
 * byte for byte; a reply that was only a promise becomes NO_WATCHER_NOTICE.
 */
export function stripFalsePromises(text: string, results: readonly StepResult[]): string {
  if (!PROMISE_PATTERN.test(text) || hasWatcher(results)) return text;
  const kept = text
    .split("\n")
    .flatMap((line) => {
      const stripped = stripLine(line);
      return stripped === line ? [line] : stripped === "" ? [] : [stripped];
    })
    .join("\n")
    .trim();
  return kept === "" ? NO_WATCHER_NOTICE : kept;
}
