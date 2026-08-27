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

/**
 * Did the supervisor route to the expected department?
 *
 * `expectedRoute: null` means a DIRECT REPLY is the correct outcome (the
 * planner's documented reply-vs-plan fork, src/kernel/planner.ts) — passes
 * only when no plan/worker was produced at all.
 *
 * Otherwise, the expected worker may legitimately be a LATER step of a
 * correct multi-step plan (e.g. `[research, comms]` when `comms` is
 * expected) — checking only the first step marks a correct plan wrong
 * (docs/EVAL-AUDIT-2026-08-28.md D2, `stress-cross-dept-chain`). Prefer the
 * full plan when the invoker recorded one; fall back to the single
 * first-step `route` for older/stubbed observations that never set `steps`.
 */
export function scoreRouting(task: GoldenTask, obs: Observation): boolean {
  if (task.expectedRoute === null) {
    return obs.route === null && (obs.steps === undefined || obs.steps.length === 0);
  }
  if (obs.steps && obs.steps.length > 0) {
    return obs.steps.some((s) => s.worker === task.expectedRoute);
  }
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
 * Message-shape patterns for a genuine INFRASTRUCTURE failure — mirrors the
 * classification already used in production (`is503Error`/`isModelFallbackError`,
 * src/agents/model.ts) and the per-call timeout (`ModelCallTimeoutError`,
 * src/gateway/model-deadline.ts). `makeKernelInvoker`'s catch stores only
 * `err.message` as a plain string (see kernel-invoker.ts), so structured
 * fields like `.code`/`.status` are gone by the time this runs — these
 * patterns are chosen to still be recognizable from the message text alone.
 *
 * Deliberately NOT matched: a `GraphRecursionError` ("Recursion limit of 25
 * reached without hitting a stop condition…") is a BEHAVIOURAL failure — the
 * worker never converged — not a provider outage, and must count as a real
 * routing/tool miss rather than being excluded (docs/EVAL-AUDIT-2026-08-28.md
 * D5 / docs/LIMITATIONS.md B5). The previous version of this function treated
 * ANY non-empty error as infra, which laundered exactly that crash class into
 * an exclusion.
 */
const INFRA_ERROR_PATTERNS: RegExp[] = [
  // HTTP 5xx/408/429 — word-boundary matches, same idiom as is503Error.
  /\b(?:500|501|502|503|504|408|429)\b/,
  // Provider-message idioms is503Error also matches on text.
  /high demand/i,
  /Service Unavailable/i,
  /Internal Server Error/i,
  /rate.?limit/i,
  /RESOURCE_EXHAUSTED/,
  // Transport-level failures (is503Error's TRANSPORT_CODES + message idioms).
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /EPIPE/,
  /socket hang up/i,
  /fetch failed/i,
  /network (?:error|timeout)/i,
  // ModelCallTimeoutError's own message (model-deadline.ts) — carries no HTTP
  // status or the string "ETIMEDOUT", only this wording + a `.code` property
  // that doesn't survive being flattened to a string message.
  /transport timeout/i,
  // Logged when withModelRetry gives up and surfaces the last provider error
  // (gateway/model-retry.ts) — the error itself already matches a pattern
  // above in practice, but match the phrase too in case it's ever embedded.
  /retry budget exhausted/i,
];

/**
 * Was this an infrastructure failure (a captured error whose SHAPE is a
 * provider outage/timeout) rather than a model or kernel decision? The runner
 * sets `obs.error` only when the invoker throws. A shape match here means the
 * task is excluded from capability metrics as transient infra; anything else
 * — including a recursion-limit crash — counts as a real capability miss.
 */
export function isInfraError(obs: Observation): boolean {
  if (typeof obs.error !== "string" || obs.error.trim().length === 0) return false;
  return INFRA_ERROR_PATTERNS.some((re) => re.test(obs.error!));
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
