/**
 * FounderOS — kernel prompt version stamp.
 * =========================================
 * `TurnTrace.promptHash` exists to answer one question after a regression:
 * *did the prompts change under us?* It could not answer it, because all four
 * `startTurn` call sites passed the literal string `"kernel-v3"` — a constant
 * that never moves when a prompt does. `activePromptHash()` (src/infra/trace.ts)
 * was written and unit-tested for exactly this and had zero callers.
 *
 * What counts as "the prompt" for a turn is the whole corpus that governs it:
 * the planner prompt AND every worker prompt. The planner prompt is itself
 * derived from the worker catalog (`buildPlannerPrompt`), so adding a tool or
 * editing one worker's instructions changes planner behaviour too — and must
 * therefore change the hash. Hashing only one half would produce a stamp that
 * silently agrees across a real prompt change, which is worse than the constant
 * it replaces: a constant is obviously uninformative, a stale hash looks like
 * evidence.
 *
 * The corpus builder is pure and takes its specs as an argument, so it is
 * testable without booting the kernel or touching the network.
 */

import { activePromptHash } from "../infra/trace.js";
import { buildPlannerPrompt, type WorkerCatalogEntry, type WorkerSpec } from "../kernel/index.js";
import { buildWorkerSpecs } from "./kernel-boot.js";

/** Separator between corpus sections — arbitrary, but must be stable across runs. */
const SECTION = "\n\n──────\n\n";

/**
 * Build the full prompt corpus governing a turn. Pure.
 *
 * Specs are sorted by id FIRST, and both halves of the corpus derive from that
 * one sorted array. Sorting only the worker sections is not enough — the
 * planner prompt embeds a `workerLines` block in catalog order
 * (`buildPlannerPrompt`, src/kernel/planner.ts:58), so an unsorted catalog
 * makes the hash move when `WORKERS` is merely reordered. A reordering is not
 * a prompt change and must not read as one.
 *
 * This means the hashed string is an order-normalized *identity* for the
 * corpus, not a byte-for-byte reproduction of what the planner receives. That
 * is the intent: the stamp answers "are these the same prompts?", and two
 * declaration orders of identical prompts are the same prompts.
 */
export function buildPromptCorpus(specs: readonly WorkerSpec[]): string {
  const sorted = [...specs].sort((a, b) => a.id.localeCompare(b.id));

  const catalog: WorkerCatalogEntry[] = sorted.map((w) => ({
    id: w.id,
    description: w.description,
    toolNames: w.tools.map((t) => t.name),
    // Mirrors buildKernel (src/kernel/graph.ts:41), which builds the planner
    // prompt with an empty gated list. Diverging here would stamp a prompt
    // shape the planner never sees.
    gatedToolNames: [],
  }));

  const workerSections = sorted.map(
    (w) => `# worker:${w.id}\n${w.description}\ntools=[${w.tools.map((t) => t.name).join(", ")}]\n${w.prompt}`,
  );

  return [`# planner\n${buildPlannerPrompt(catalog)}`, ...workerSections].join(SECTION);
}

let _cached: string | null = null;

/**
 * 12-char sha256 of the active prompt corpus, computed once per process.
 *
 * Cached because `buildWorkerSpecs()` walks every department's tool registry
 * and this runs on the hot path of every turn. Prompts are module constants —
 * they cannot change without a restart, so a process-lifetime cache is exact,
 * not merely an approximation.
 *
 * Never throws: a hashing failure must not be able to fail a founder's turn.
 * On failure it returns a value that is visibly NOT a hash, so a degraded stamp
 * can never be mistaken for a real one.
 */
export function kernelPromptHash(): string {
  if (_cached !== null) return _cached;
  try {
    _cached = activePromptHash(buildPromptCorpus(buildWorkerSpecs()));
  } catch {
    // allow-failopen: the prompt stamp is trace metadata; a turn must never die for it.
    // "unavailable" is deliberately not hash-shaped — see the module header.
    _cached = "unavailable";
  }
  return _cached;
}

/** Test seam — clears the process-lifetime cache. */
export function _resetKernelPromptHash(): void {
  _cached = null;
}
