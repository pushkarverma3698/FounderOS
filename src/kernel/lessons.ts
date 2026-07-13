/**
 * FounderOS v3 kernel — failure-lesson memory (the Hermes learning seam).
 * ========================================================================
 * The supervisor already gives every retryable failure ONE corrected retry.
 * Until now that intelligence evaporated: the same error signature failed the
 * same blind way next month. This module makes the retry seam LEARN, by code:
 *
 *   - when a retry is dispatched, the failure message is normalized into a
 *     stable signature and a lesson for (worker, signature) is looked up in
 *     the injected LessonStore — a hit is appended to the retry envelope as
 *     one deterministic message (prior evidence, not a prompt rewrite);
 *   - when the retried step then validates OK, the (worker, signature →
 *     tools that resolved it) pair is recorded for every future turn.
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
  /** How many times this signature has been seen (recorded) so far. */
  times_seen: number;
  /** ISO timestamp of the last successful resolution. */
  last_resolved_at: string;
}

export interface LessonStore {
  /** Best lesson for this (worker, signature), or null. Must not throw upward. */
  lookup(worker: string, signature: string): Promise<FailureLesson | null>;
  /** Record/refresh a resolution. Must not throw upward. */
  record(lesson: Omit<FailureLesson, "times_seen" | "last_resolved_at">): Promise<void>;
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
        let lesson: FailureLesson | null = null;
        try {
          lesson = await lessons.lookup(step.worker, signature);
        } catch {
          /* allow-failopen: a lesson lookup blip must never break the retry it decorates */
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
