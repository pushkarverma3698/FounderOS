/**
 * FounderOS — Eval Runner
 * ========================
 * Drives a list of golden tasks through an INJECTED invoker and returns a scored
 * report. Dependency injection is deliberate (mirrors buildOffice(checkpointer)):
 *   - unit tests pass a deterministic stub invoker → zero LLM cost, reproducible
 *   - `pnpm eval` passes a real invoker that runs the office graph
 *
 * The runner never throws on a task failure — an invoker error is captured as a
 * failed observation so one flaky call can't abort the whole eval.
 */

import { scoreTask, aggregate } from "./scoring.js";
import type { GoldenTask, Observation, EvalReport } from "./types.js";

// Re-export so callers import task/observation shapes from one place.
export type { GoldenTask, Observation, EvalReport } from "./types.js";

/** Runs one golden task and reports what the system actually did. */
export type Invoker = (task: GoldenTask) => Promise<Observation>;

/**
 * Run every task through `invoke`, score it, and aggregate.
 * Tasks run sequentially to keep load (and cost) predictable; order is preserved.
 *
 * @param options.taskDelayMs  Milliseconds to wait between tasks (default 0).
 *   Pass 1500 in the live eval script to reduce API hammering during capacity spikes.
 *   Unit tests leave it at 0 to stay fast.
 */
export async function runEval(
  tasks: GoldenTask[],
  invoke: Invoker,
  options?: { taskDelayMs?: number },
): Promise<EvalReport> {
  const taskDelayMs = options?.taskDelayMs ?? 0;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    if (i > 0 && taskDelayMs > 0) await sleep(taskDelayMs);

    const task = tasks[i]!;
    let obs: Observation;
    try {
      obs = await invoke(task);
    } catch (err) {
      obs = {
        route: null,
        tools: [],
        hadInterrupt: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(scoreTask(task, obs));
  }
  return aggregate(results);
}
