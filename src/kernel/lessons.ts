/**
 * FounderOS v3 kernel — failure-lesson memory (the Hermes learning seam).
 * ========================================================================
 * The supervisor already gives every retryable failure ONE corrected retry.
 * Until now that intelligence evaporated: the same error signature failed the
 * same blind way next month. This module makes the retry seam LEARN, by code:
 *
 *   - when a retry is dispatched, the failure message is normalized into a
 *     stable signature; the OCCURRENCE is recorded (`times_seen`) whether or
 *     not that retry later succeeds, then a lesson for (worker, signature) is
 *     looked up in the injected LessonStore — a hit is appended to the retry
 *     envelope as one deterministic message (prior evidence, not a prompt
 *     rewrite);
 *
 * SCOPE OF `times_seen` — read this before answering "how often does X fail":
 * the occurrence write lives on the RETRY-DISPATCH path (Hook 2), so it counts
 * failures that ENTERED THE RETRY SEAM, not all failures. Two shapes are
 * deliberately NOT counted, because dispatch never builds a retry for them
 * (src/kernel/supervisor.ts:165 — `last.failure.retryable && attempt <
 * MAX_ATTEMPTS_PER_STEP`):
 *   - a NON-RETRYABLE failure (retryable: false) — recorded 0 times;
 *   - the FINAL attempt of an exhausted step — a step that fails all
 *     MAX_ATTEMPTS_PER_STEP times records MAX_ATTEMPTS_PER_STEP - 1
 *     occurrences, because the terminal failure has no retry after it.
 * So `times_seen` is a lower bound on failures, exact for the retry seam.
 * Pinned by "AUDIT scope" tests in tests/unit/kernel/lessons.test.ts.
 *   - when the retried step then validates OK, the RESOLUTION is recorded
 *     separately (`times_resolved`) — the (worker, signature → tools that
 *     resolved it) pair, for every future turn.
 *
 * Kernel-library rules hold: the store is INJECTED (Postgres in prod, fakes
 * in CI), the decorator wraps the pure dispatch without touching its logic,
 * and a store blip can never break a turn — lessons are an accelerant, not a
 * dependency.
 */

import { HumanMessage } from "@langchain/core/messages";
import { dispatch } from "./supervisor.js";
import { RESET } from "./state.js";
import type { KernelStateType, KernelUpdate } from "./state.js";
import type { Mission, StepResult } from "./contracts.js";

// ── Signature normalization (pure) ────────────────────────────────────────────

/** Cap so signatures stay index-friendly and stable across long stack traces. */
export const SIGNATURE_MAX_CHARS = 200;

/**
 * Collapse the volatile parts of an error message (ids, hashes, numbers,
 * URLs, emails, quoted payloads) so the SAME failure mode maps to the SAME
 * signature across occurrences. Deterministic and total.
 */
export function normalizeFailureSignature(message: string): string {
  return message
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\b[0-9a-f]{16,64}\b/g, "<hash>")
    .replace(/https?:\/\/[^\s"']+/g, "<url>")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>")
    .replace(/"(?:[^"\\]|\\.){40,}"/g, "<payload>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SIGNATURE_MAX_CHARS);
}

// ── Store contract (injected at the composition root) ─────────────────────────

export interface FailureLesson {
  worker: string;
  signature: string;
  component: string;
  /** Objective of the step that recorded the lesson (context for the model). */
  objective: string;
  /** Tools whose successful receipts backed the resolving attempt. */
  resolved_with_tools: string[];
  /**
   * Occurrences of this signature that entered the retry seam, resolved or
   * not. A lower bound on total failures — see the SCOPE note in the module
   * header for the two shapes it deliberately excludes.
   */
  times_seen: number;
  /** Of those occurrences, how many a retry subsequently resolved. */
  times_resolved: number;
  /** ISO timestamp of the last successful resolution. */
  last_resolved_at: string;
}

/** What gets written on the FAILURE path — every retried sighting, whether or not it later resolves. */
export interface FailureOccurrence {
  worker: string;
  signature: string;
  component: string;
  /** Objective of the step that saw this failure (context for the model). */
  objective: string;
}

export interface LessonStore {
  /** Best lesson for this (worker, signature), or null. Must not throw upward. */
  lookup(worker: string, signature: string): Promise<FailureLesson | null>;
  /** Record/refresh a RESOLUTION (a retry that just settled ok). Must not throw upward. */
  record(lesson: Omit<FailureLesson, "times_seen" | "times_resolved" | "last_resolved_at">): Promise<void>;
  /**
   * Record an OCCURRENCE (the failure path — a retry is about to be
   * dispatched for this signature). Called on EVERY failure, independent of
   * whether the retry later succeeds — this is what stops a signature that
   * fails identically N times with zero successful retries from writing zero
   * rows. Must not throw upward.
   */
  recordOccurrence(occurrence: FailureOccurrence): Promise<void>;
}

/** The one deterministic sentence injected into a retry envelope on a lesson hit. */
export function lessonMessage(lesson: FailureLesson): string {
  const tools =
    lesson.resolved_with_tools.length > 0 ? lesson.resolved_with_tools.join(", ") : "no tool calls (corrected output only)";
  return (
    `KNOWN FAILURE PATTERN (seen ${lesson.times_seen}×, last resolved ${lesson.last_resolved_at.slice(0, 10)}): ` +
    `this same error was previously overcome by a corrected attempt using: ${tools}. ` +
    `Original context: "${lesson.objective.slice(0, 120)}". ` +
    `Apply the same correction instead of repeating the failed approach.`
  );
}

// ── Dispatch decorator ─────────────────────────────────────────────────────────

/** What the retry stashes so the later success knows WHAT it just proved. */
export interface LessonCandidate {
  step_id: string;
  worker: string;
  signature: string;
  component: string;
  objective: string;
}

function latestResultFor(stepId: string, results: StepResult[]): StepResult | undefined {
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i]!.step_id === stepId) return results[i]!;
  }
  return undefined;
}

/**
 * Wrap the PURE dispatch with the two lesson hooks. Discrimination is
 * structural, not heuristic: only dispatch's retry branch emits a
 * `results: { set }` update, and only a stashed candidate whose step later
 * carries an ok result means "a retry just succeeded".
 */
export function makeLessonDispatch(lessons?: LessonStore) {
  return async function lessonDispatch(state: KernelStateType): Promise<KernelUpdate> {
    const update = dispatch(state);
    if (!lessons) return update;

    const out: KernelUpdate = { ...update };

    // Hook 1 — a previously stashed retry has settled: record or discard.
    const candidate = state.lesson_candidate;
    if (candidate) {
      const settled = latestResultFor(candidate.step_id, state.results);
      if (settled?.status === "ok") {
        const tools = [...new Set(settled.tool_receipts.filter((r) => r.ok).map((r) => r.tool))];
        try {
          await lessons.record({
            worker: candidate.worker,
            signature: candidate.signature,
            component: candidate.component,
            objective: candidate.objective,
            resolved_with_tools: tools,
          });
        } catch {
          /* allow-failopen: lesson persistence is an accelerant; a store blip must never break the turn */
        }
      }
      out.lesson_candidate = null; // settled either way — never re-record, never leak across steps
    }

    // Hook 2 — dispatch just built a retry: stash the signature + inject any known lesson.
    // dispatch always emits plain Mission objects (never OverwriteValue) — narrow structurally.
    const mission = out.mission && "status" in out.mission ? (out.mission as Mission) : undefined;
    const isRetry =
      mission?.status === "executing" &&
      out.results !== undefined &&
      typeof out.results === "object" &&
      !Array.isArray(out.results) &&
      "set" in out.results;
    if (isRetry && mission) {
      const plan = state.mission.plan;
      const step = plan?.steps[mission.cursor];
      const failed = step ? latestResultFor(step.step_id, state.results) : undefined;
      if (step && failed?.status === "failed") {
        const signature = normalizeFailureSignature(failed.failure.message);
        out.lesson_candidate = {
          step_id: step.step_id,
          worker: step.worker,
          signature,
          component: failed.failure.component,
          objective: step.objective,
        };
        // Look up FIRST so the injected message reports history strictly
        // prior to this failure, then record THIS occurrence — order doesn't
        // change final counts, only what "seen N×" means at injection time.
        let lesson: FailureLesson | null = null;
        try {
          lesson = await lessons.lookup(step.worker, signature);
        } catch {
          /* allow-failopen: a lesson lookup blip must never break the retry it decorates */
        }
        try {
          await lessons.recordOccurrence({
            worker: step.worker,
            signature,
            component: failed.failure.component,
            objective: step.objective,
          });
        } catch {
          /* allow-failopen: occurrence persistence is an accelerant; a store blip must never break the turn */
        }
        if (lesson && out.scratch && typeof out.scratch === "object" && !Array.isArray(out.scratch)) {
          const stepScratch = (out.scratch as Record<string, any>)[step.step_id];
          if (stepScratch && "set" in stepScratch) {
            (out.scratch as Record<string, any>)[step.step_id] = {
              set: [...stepScratch.set, new HumanMessage(lessonMessage(lesson))],
            };
          }
        }
      }
    }

    return out;
  };
}
