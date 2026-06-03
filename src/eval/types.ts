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

/** The six routable departments (mirrors the office sub-agents). */
export type Department =
  | "research"
  | "comms"
  | "engineering"
  | "marketing"
  | "sales"
  | "prospecting"
  | "personal";

/** A single golden evaluation case: the expected behaviour for one input. */
export interface GoldenTask {
  /** Stable id, used in the report. */
  id: string;
  /** The user message sent into the office. */
  input: string;
  /** The department the supervisor should route to. */
  expectedRoute: Department;
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

/** What we actually observed from running one task through the office. */
export interface Observation {
  /** Department actually routed to (from a `transfer_to_*` handoff), or null. */
  route: Department | null;
  /** Tool names actually invoked during the run. */
  tools: string[];
  /** Whether the run paused on a HITL `interrupt()`. */
  hadInterrupt: boolean;
  /** Optional error captured while running the task. */
  error?: string;
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
  results: TaskResult[];
}
