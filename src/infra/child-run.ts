/**
 * FounderOS — run a maintenance child process and keep its last words
 * ===================================================================
 * One helper for the scheduler's spawned sweeps, because they had the same
 * defect twice: `stdio: "ignore"`.
 *
 * The funding-registry grower began crashing on 2026-09-03 and crashed every
 * night through 2026-09-07. All production ever recorded was `{"code":1}` —
 * four identical lines, no cause, and a discovery channel that was completely
 * dead while looking merely unlucky. `runBrainSync` was spawned the same way,
 * so the nightly RAG sync had exactly the same blind spot waiting.
 *
 * An exit code alone does not tell you what broke. This captures stderr's tail
 * (where the thrown error is) and puts it in the failure log line.
 */

import { spawn } from "node:child_process";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "child-run" });

/** How much of a failed child's stderr to keep. Enough for a stack's first frames. */
export const CHILD_STDERR_TAIL_CHARS = 2_000;

export interface ChildRunResult {
  readonly code: number | null;
  readonly stderr: string;
}

/**
 * Spawn a child, wait for it, and log the outcome. Never throws and never
 * rejects — a maintenance sweep failing must not take the bot down with it.
 */
export function runMaintenanceChild(
  command: string,
  args: readonly string[],
  label: string,
): Promise<ChildRunResult> {
  return new Promise<ChildRunResult>((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "ignore", "pipe"], detached: false });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // Keep the TAIL: a crash puts its message at the end, not the start.
      stderr = (stderr + chunk.toString("utf8")).slice(-CHILD_STDERR_TAIL_CHARS);
    });
    child.on("exit", (code) => {
      if (code === 0) log.info({ label }, `${label} completed`);
      else log.error({ label, code, stderr: stderr.trim() || "(no stderr captured)" }, `${label} failed`);
      resolve({ code, stderr: stderr.trim() });
    });
    child.on("error", (err) => {
      log.error({ label, err: err.message }, `${label} spawn error`);
      resolve({ code: null, stderr: err.message });
    });
  });
}
