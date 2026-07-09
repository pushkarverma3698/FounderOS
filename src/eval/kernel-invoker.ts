/**
 * FounderOS v3 — eval invoker for the kernel.
 * ============================================
 * Adapts the compiled kernel to the eval runner's Invoker seam. Routing is
 * read from the VALIDATED plan (typed data), not parsed out of transfer-tool
 * prose like the old office-invoker had to.
 */

import type { CompiledKernel } from "../kernel/index.js";
import type { Department, GoldenTask, Observation } from "./types.js";
import type { Invoker } from "./runner.js";

let counter = 0;

export function makeKernelInvoker(kernel: CompiledKernel): Invoker {
  return async function invoke(task: GoldenTask): Promise<Observation> {
    const threadId = `eval:${Date.now()}:${counter++}`;
    const config = { configurable: { thread_id: threadId } };
    try {
      const res = await kernel.invoke(
        {
          turn: {
            id: threadId,
            chat_id: "eval",
            received_at: new Date().toISOString(),
            raw_input: task.input,
          },
        },
        config,
      );

      const steps = res.mission.plan?.steps ?? [];
      const route = (steps[0]?.worker ?? null) as Department | null;
      const tools = res.results.flatMap((r) =>
        r.status === "ok" ? r.tool_receipts.map((t) => t.tool) : [],
      );
      const state = (await kernel.getState(config)) as {
        tasks?: Array<{ interrupts?: Array<{ value: unknown }> }>;
      };
      const hadInterrupt = (state.tasks ?? []).some((t) => (t.interrupts ?? []).length > 0);

      return { route, tools: [...new Set(tools)], hadInterrupt };
    } catch (err) {
      return { route: null, tools: [], hadInterrupt: false, error: (err as Error).message };
    }
  };
}
