/**
 * Per-run model overrides for the paid eval (AG-031 part 2).
 *
 *   pnpm eval --suite understanding --planner-model anthropic:claude-sonnet-5-5 \
 *                                   --worker-model  google-genai:gemini-3.6-flash
 *
 * The flags are turned into the SAME env vars production reads (AGENT_MODEL,
 * WORKER_AGENT_MODEL) before the kernel is built, so the run goes through the real
 * parseModelId / buildModel / getWorkerModel path and not a parallel one. Three
 * guards keep the comparison honest:
 *
 *  - fallback chains are emptied whenever an override is given, so a model that
 *    fails is a loud infra error instead of a silent swap to another provider;
 *  - assertOverridesApplied() checks the stage report after the kernel is built,
 *    because getWorkerModel() falls back to the primary without throwing when the
 *    worker model's key is missing, and that would put the wrong model in a row;
 *  - the LLM response cache must be off: a hit skips the model and fakes both the
 *    latency and the cost.
 *
 * Pure apart from the explicit env argument: no network, no model construction.
 */

import { normalizeModelId, parseModelId } from "../agents/model.js";
import { missingCredentialReason } from "../agents/model-truth.js";

export interface ModelOverrides {
  /** Prefixed id for the planner stage (AGENT_MODEL). */
  readonly plannerModel?: string;
  /** Prefixed id for the worker and synthesizer stages (WORKER_AGENT_MODEL). */
  readonly workerModel?: string;
}

export interface StageModels {
  readonly planner: string;
  readonly worker: string;
  readonly synthesizer: string;
}

const PLANNER_FLAG = "--planner-model";
const WORKER_FLAG = "--worker-model";

/** Env vars that would let a failing override silently fall through to another model. */
const FALLBACK_ENV_VARS = ["AGENT_FALLBACK_MODELS", "PLANNER_FALLBACK_MODELS", "WORKER_FALLBACK_MODELS"] as const;

/** Value of `flag` in argv (`--flag value` or `--flag=value`), or undefined when absent. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const hits = argv.flatMap((arg, i) => (arg === flag || arg.startsWith(`${flag}=`) ? [i] : []));
  if (hits.length === 0) return undefined;
  if (hits.length > 1) throw new Error(`${flag} given more than once.`);
  const at = hits[0]!;
  const arg = argv[at]!;
  const value = arg === flag ? argv[at + 1] : arg.slice(flag.length + 1);
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a model id.`);
  return value;
}

/** Resolve a flag value the way production resolves AGENT_MODEL, naming the flag on failure. */
function resolveModelId(flag: string, raw: string): string {
  try {
    return parseModelId(normalizeModelId(raw)).id;
  } catch (err) {
    throw new Error(`${flag} "${raw}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Read --planner-model / --worker-model from argv. No flags means the baseline (prod config). */
export function parseOverrideArgs(argv: readonly string[]): ModelOverrides {
  const planner = flagValue(argv, PLANNER_FLAG);
  const worker = flagValue(argv, WORKER_FLAG);
  return {
    ...(planner !== undefined && { plannerModel: resolveModelId(PLANNER_FLAG, planner) }),
    ...(worker !== undefined && { workerModel: resolveModelId(WORKER_FLAG, worker) }),
  };
}

/** Env values that make production's model path build the requested models. Empty for the baseline. */
export function overrideEnvPatch(overrides: ModelOverrides): Record<string, string> {
  if (!overrides.plannerModel && !overrides.workerModel) return {};
  return {
    ...(overrides.plannerModel ? { AGENT_MODEL: overrides.plannerModel } : {}),
    ...(overrides.workerModel ? { WORKER_AGENT_MODEL: overrides.workerModel } : {}),
    ...Object.fromEntries(FALLBACK_ENV_VARS.map((name) => [name, ""])),
  };
}

/** Apply the patch to `env` (process.env in the script, a plain object in tests). */
export function applyOverrides(env: NodeJS.ProcessEnv, overrides: ModelOverrides): void {
  Object.assign(env, overrideEnvPatch(overrides));
}

/** Why the worker stage is not on the requested model, for the error message. */
function workerGap(requested: string, actual: string, env: NodeJS.ProcessEnv): string {
  if (actual === "unresolved") return "the worker model was never resolved";
  return missingCredentialReason(parseModelId(requested).provider, env);
}

/**
 * Throw when a requested override is not what the kernel actually resolved. Call it
 * after buildProductionKernel() and before spending anything.
 */
export function assertOverridesApplied(
  overrides: ModelOverrides,
  stages: StageModels,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (overrides.plannerModel && stages.planner !== overrides.plannerModel) {
    throw new Error(
      `${PLANNER_FLAG} ${overrides.plannerModel} did not take effect: the planner resolved to ${stages.planner}.`,
    );
  }
  if (overrides.workerModel && stages.worker !== overrides.workerModel) {
    throw new Error(
      `${WORKER_FLAG} ${overrides.workerModel} did not take effect: the worker and synthesizer stages ` +
        `resolved to ${stages.worker} (${workerGap(overrides.workerModel, stages.worker, env)}).`,
    );
  }
}

/** A paid A/B run must hit the model every time; refuse when the response cache is on. */
export function assertResponseCacheOff(env: NodeJS.ProcessEnv): void {
  if (env["LLM_CACHE_ENABLED"] === "true") {
    throw new Error(
      "LLM_CACHE_ENABLED=true: cached planner/synthesizer replies skip the model, so latency and cost would " +
        "be wrong. Run the eval with LLM_CACHE_ENABLED=false.",
    );
  }
}
