/**
 * FounderOS — Eval Harness Scoring (pure)
 * ========================================
 * Pure functions that turn (GoldenTask, Observation) pairs into scored results
 * and aggregate them into report metrics. No LLM, no I/O — fully unit-testable.
 *
 * Metric philosophy: each metric is computed only over the tasks that *declare*
 * the relevant expectation, so the number means what it says:
 *   - routing       — every task (every task has an expectedRoute)
 *   - toolSelection — only tasks with a non-empty expectedTools
 *   - hitlCoverage  — only tasks with expectsHitl defined
 *   - overall       — every task (all applicable checks must pass)
 */

import type {
  GoldenTask,
  Observation,
  TaskResult,
  MetricSummary,
  EvalReport,
} from "./types.js";

/** Did the supervisor route to the expected department? */
export function scoreRouting(task: GoldenTask, obs: Observation): boolean {
  return obs.route === task.expectedRoute;
}

/**
 * Were the expected tools used? Subset match — passes if every expected tool is
 * present in the observed tool calls. Vacuously true when no tools are expected.
 */
export function scoreToolSelection(task: GoldenTask, obs: Observation): boolean {
  if (!task.expectedTools || task.expectedTools.length === 0) return true;
  return task.expectedTools.every((t) => obs.tools.includes(t));
}

/**
 * Did the HITL gate behave? Passes when an interrupt happened iff one was
 * expected. Vacuously true when the task declares no expectation.
 */
export function scoreHitl(task: GoldenTask, obs: Observation): boolean {
  if (task.expectsHitl === undefined) return true;
  return task.expectsHitl === obs.hadInterrupt;
}

/**
 * Was this an infrastructure failure (a captured error) rather than a model
 * decision? The runner sets `obs.error` only when the invoker throws — e.g. a
 * 503 that exhausted every retry/fallback. Such a task is NOT a routing miss.
 */
export function isInfraError(obs: Observation): boolean {
  return typeof obs.error === "string" && obs.error.trim().length > 0;
}

/** Score one task across all three dimensions. */
export function scoreTask(task: GoldenTask, obs: Observation): TaskResult {
  const routeCorrect = scoreRouting(task, obs);
  const toolsCorrect = scoreToolSelection(task, obs);
  const hitlCorrect = scoreHitl(task, obs);
  return {
    task,
    observation: obs,
    routeCorrect,
    toolsCorrect,
    hitlCorrect,
    infraError: isInfraError(obs),
    passed: routeCorrect && toolsCorrect && hitlCorrect,
  };
}

/** Build a MetricSummary from a count of applicable + passing tasks. */
function summarize(passed: number, total: number): MetricSummary {
  return { total, passed, accuracy: total === 0 ? 0 : passed / total };
}

/**
 * Aggregate scored task results into per-metric summaries + overall.
 *
 * Infra-errored tasks are EXCLUDED from every capability metric (routing / tool /
 * HITL / overall) and reported separately as `infraErrors`. A transient 503 that
 * escaped the model layer is an infrastructure fact, not a routing decision —
 * counting it as a routing miss would silently deflate the capability score and
 * hide the real signal. All results (infra-errored included) are still returned
 * so the report can list them transparently.
 */
export function aggregate(results: TaskResult[]): EvalReport {
  // Capability metrics are computed only over tasks that actually ran (no infra error).
  const scorable = results.filter((r) => !r.infraError);
  const infraErrors = results.length - scorable.length;

  // routing: applies to every scorable task
  const routing = summarize(
    scorable.filter((r) => r.routeCorrect).length,
    scorable.length,
  );

  // tool selection: only scorable tasks that declared expected tools
  const toolTasks = scorable.filter(
    (r) => (r.task.expectedTools?.length ?? 0) > 0,
  );
  const toolSelection = summarize(
    toolTasks.filter((r) => r.toolsCorrect).length,
    toolTasks.length,
  );

  // hitl coverage: only scorable tasks that declared a HITL expectation
  const hitlTasks = scorable.filter((r) => r.task.expectsHitl !== undefined);
  const hitlCoverage = summarize(
    hitlTasks.filter((r) => r.hitlCorrect).length,
    hitlTasks.length,
  );

  const overall = summarize(scorable.filter((r) => r.passed).length, scorable.length);

  return {
    generatedAt: new Date().toISOString(),
    routing,
    toolSelection,
    hitlCoverage,
    overall,
    infraErrors,
    results,
  };
}
