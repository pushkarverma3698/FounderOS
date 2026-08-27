/**
 * FounderOS — Eval Harness Types
 * ===============================
 * Shared shapes for the deterministic agent-evaluation harness. The harness runs
 * a fixed set of golden tasks through the office and scores three things:
 *   1. Routing       — did the supervisor hand off to the right department?
 *   2. Tool selection — did that department use the tools we expect?
 *   3. HITL coverage  — did a write action pause for approval when it should?
 *
 * Scoring is pure (see scoring.ts). The runner accepts an injectable invoker so
 * unit tests use a deterministic stub (zero LLM cost) and `pnpm eval` uses the
 * real office graph.
 */

/** The routable departments (mirrors the office sub-agents). */
export type Department =
  | "admin"
  | "research"
  | "comms"
  | "engineering"
  | "marketing"
  | "sales"
  | "personal"
  | "jobhunt";

/** A single golden evaluation case: the expected behaviour for one input. */
export interface GoldenTask {
  /** Stable id, used in the report. */
  id: string;
  /** The user message sent into the office. */
  input: string;
  /**
   * The department the supervisor should route to, or `null` when a DIRECT
   * REPLY (no plan, no worker at all) is the correct outcome — the planner's
   * documented fork (src/kernel/planner.ts) between a direct reply and a typed
   * Plan is architecture, not a routing miss (docs/EVAL-AUDIT-2026-08-28.md D4).
   */
  expectedRoute: Department | null;
  /**
   * Tools the department is expected to use. Subset match: the task passes if
   * every listed tool appears in the observed tool calls. Omit when routing is
   * the only thing under test.
   */
  expectedTools?: string[];
  /**
   * Whether this task should pause on a HITL approval (interrupt). Omit when the
   * task does not test the approval gate.
   */
  expectsHitl?: boolean;
  /** Optional human note shown in the report. */
  note?: string;
}

/** One step of the plan the planner actually produced. */
export interface PlanStepObservation {
  worker: Department;
  objective: string;
}

/** One observed tool invocation, including calls that failed or are paused on approval. */
export interface ToolCallObservation {
  tool: string;
  ok: boolean;
}

/** What we actually observed from running one task through the office. */
export interface Observation {
  /**
   * Worker of the FIRST plan step, or null when the planner replied directly
   * or the run errored before a plan existed. Kept for backward compatibility
   * with older scoring/report code; prefer `steps` for the full sequence —
   * see scoreRouting in scoring.ts, which checks the whole plan.
   */
  route: Department | null;
  /**
   * Tool names actually invoked during the run (deduped), regardless of
   * whether the call succeeded — see `toolCalls` for per-call outcomes.
   */
  tools: string[];
  /** Whether the run paused on a HITL `interrupt()`. */
  hadInterrupt: boolean;
  /** Optional error captured while running the task. */
  error?: string;
  /**
   * The full plan step sequence (worker + objective), in order. Undefined or
   * empty when the planner produced a direct reply (no plan) or the run
   * errored before a plan existed. Lets scoring ask "does the expected worker
   * appear ANYWHERE in the plan" instead of only the first step
   * (docs/EVAL-AUDIT-2026-08-28.md D2).
   */
  steps?: PlanStepObservation[];
  /**
   * Every observed tool call, INCLUDING calls that failed or paused on a HITL
   * gate before finishing — a superset of `tools` kept so a report can
   * distinguish "called but failed" from "never called" without re-running
   * the task (docs/EVAL-AUDIT-2026-08-28.md D7).
   */
  toolCalls?: ToolCallObservation[];
}

/** A single golden task after scoring. */
export interface TaskResult {
  task: GoldenTask;
  observation: Observation;
  routeCorrect: boolean;
  /** True if every expected tool was observed (or no tools were expected). */
  toolsCorrect: boolean;
  /** True if HITL happened iff expected (or no HITL expectation was declared). */
  hitlCorrect: boolean;
  /**
   * True when the run failed for an INFRASTRUCTURE reason (the observation carried
   * an `error`, e.g. a 503 that escaped the model layer), as opposed to the model
   * genuinely choosing the wrong route. Infra-errored tasks are set aside in
   * aggregate() so transient infra flakiness can't masquerade as a capability miss.
   */
  infraError: boolean;
  /** True only when all *applicable* checks passed. */
  passed: boolean;
}

/** Pass/total/accuracy for one metric, computed over its applicable tasks. */
export interface MetricSummary {
  total: number;
  passed: number;
  /** passed / total, in [0,1]. 0 when total is 0 (never NaN). */
  accuracy: number;
}

/** The full eval report — per-metric summaries plus every task result. */
export interface EvalReport {
  generatedAt: string;
  routing: MetricSummary;
  toolSelection: MetricSummary;
  hitlCoverage: MetricSummary;
  overall: MetricSummary;
  /**
   * Count of tasks excluded from the capability metrics because they hit an
   * infrastructure error (transient 503/timeout that escaped the model layer),
   * not a genuine routing/tool/HITL miss. Reported separately so a flaky run is
   * legible rather than silently deflating the score.
   */
  infraErrors: number;
  results: TaskResult[];
}
