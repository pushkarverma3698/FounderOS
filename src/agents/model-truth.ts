/**
 * Model truth (AG-031 part 1): which model really serves each stage.
 *
 * getWorkerModel() silently fell back to the primary when the worker id could not
 * be built, and the ledger could not tell the difference (every cost row named
 * AGENT_MODEL). This module records the decision once, logs a fallback with its
 * reason, and exposes the effective id per stage so cost attribution, the boot
 * log and tests all read the same answer.
 *
 * Pure bookkeeping: no model construction here (model.ts owns that), so there is
 * no import cycle.
 */

import { logger } from "../infra/logger.js";

type Warn = (obj: Record<string, unknown>, msg: string) => void;
let log: { warn: Warn } | undefined; // resolved lazily: many suites mock the logger module

/** Test seam: capture the one-time fallback line. */
export function setModelTruthLogForTests(l: { warn: Warn }): void {
  log = l;
}

export interface WorkerModelChoice {
  readonly requestedId: string;
  readonly effectiveId: string;
  /** Set only when the requested worker model could not be used. */
  readonly fallbackReason?: string;
}

let choice: WorkerModelChoice | undefined;
const logged = new Set<string>();

export function resetWorkerModelChoiceForTests(): void {
  choice = undefined;
  logged.clear();
}

/** Why `buildModel(..., { optional: true })` returned null for this provider. */
export function missingCredentialReason(provider: string, env: NodeJS.ProcessEnv = process.env): string {
  switch (provider) {
    case "google-vertexai":
      return [!env["GOOGLE_APPLICATION_CREDENTIALS"] && "GOOGLE_APPLICATION_CREDENTIALS", !env["GOOGLE_CLOUD_PROJECT"] && "GOOGLE_CLOUD_PROJECT"]
        .filter(Boolean)
        .join(" and ")
        .concat(" is not set");
    case "google-genai":
      return "GOOGLE_GENERATIVE_AI_API_KEY is not set";
    case "anthropic":
      return "ANTHROPIC_API_KEY is not set";
    case "openrouter":
      return "OPENROUTER_API_KEY is not set";
    default:
      return "OPENAI_API_KEY is not set";
  }
}

/**
 * Record which model the worker + synthesizer stages will use. A fallback is
 * logged once per (requested, effective) pair, at the first call, not per turn.
 */
export function noteWorkerModelChoice(next: WorkerModelChoice): void {
  choice = next;
  if (!next.fallbackReason) return;
  const key = `${next.requestedId}->${next.effectiveId}`;
  if (logged.has(key)) return;
  logged.add(key);
  (log ??= logger.child({ module: "model-truth" })).warn(
    { requested: next.requestedId, effective: next.effectiveId },
    `worker model ${next.requestedId} unavailable: ${next.fallbackReason}; using ${next.effectiveId}`,
  );
}

/** The worker model actually in use, or undefined before getWorkerModel() has run. */
export function getEffectiveWorkerModelId(): string | undefined {
  return choice?.effectiveId;
}

/** Effective model id per kernel stage, for the boot log. */
export function describeStageModels(plannerId: string): { planner: string; worker: string; synthesizer: string } {
  const worker = choice?.effectiveId ?? "unresolved";
  return { planner: plannerId, worker, synthesizer: worker };
}

/** Best-effort id of a built chat model instance (fallbacks are built without their chain id). */
export function modelNameOf(m: unknown): string | undefined {
  const o = m as { model?: unknown; modelName?: unknown } | null;
  const name = o?.model ?? o?.modelName;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}
