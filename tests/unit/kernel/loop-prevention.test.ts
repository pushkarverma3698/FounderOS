import { describe, it, expect } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  buildKernel,
  KERNEL_SCHEMA_VERSION,
  type KernelBindableModel,
  type KernelTool,
  type WorkerSpec,
} from "../../../src/kernel/index.js";

class ScriptedModel implements KernelBindableModel {
  calls = 0;
  received: BaseMessage[][] = [];
  constructor(private script: Array<AIMessage | Error | ((msgs: BaseMessage[]) => AIMessage)>, private loop = false) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.received.push(messages);
    const idx = this.loop ? this.calls % this.script.length : this.calls;
    this.calls += 1;
    const entry = this.script[idx];
    if (!entry) throw new Error(`ScriptedModel exhausted after ${this.calls - 1} calls`);
    if (entry instanceof Error) throw entry;
    return typeof entry === "function" ? entry(messages) : entry;
  }
}

const ai = (content: string) => new AIMessage(content);
const VALID_OUTPUT = ai(JSON.stringify({ summary: "LangGraph 1.4 released", sources: [] }));

const planJson = (maxToolCalls = 2) =>
  JSON.stringify({
    type: "plan",
    plan: {
      schema_version: KERNEL_SCHEMA_VERSION,
      goal: "prevent loops",
      steps: [
        {
          step_id: "s1",
          worker: "research",
          objective: "Compare agents",
          inputs: {},
          expected: { kind: "data", schema_ref: "research.findings" },
          constraints: { max_tool_calls: maxToolCalls, hitl_required: false },
        },
      ],
    },
  });

describe("v3 kernel loop prevention & retry preservation", () => {
  it("stubborn tool calls consume budget and terminate instead of looping infinitely", async () => {
    let toolInvocations = 0;
    const searchTool: KernelTool = {
      name: "search_web",
      description: "search the web",
      invoke: async () => {
        toolInvocations += 1;
        throw new Error("tool failed"); // first attempt fails
      },
    };

    const workers: WorkerSpec[] = [
      { id: "research", description: "web research", prompt: "Prompt", tools: [searchTool] },
    ];

    // Scripted model stubbornly makes the exact same tool call over and over.
    const worker = new ScriptedModel(
      [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "search_web", args: { query: "test" }, id: "c1" }],
        }),
      ],
      true // loop the response
    );

    const kernel = buildKernel({
      plannerModel: new ScriptedModel([ai(planJson(2))]), // max 2 tool calls
      workerModel: worker,
      synthesizerModel: new ScriptedModel([ai("Done.")]),
      workers,
      checkpointer: new MemorySaver(),
    });

    const res = await kernel.invoke(
      {
        turn: { id: "t_loop", chat_id: "1", received_at: new Date().toISOString(), raw_input: "run" },
      },
      { configurable: { thread_id: "thread_loop" } }
    );

    // The turn should terminate as failed (due to validation/JSON finalization failure)
    // rather than looping infinitely or throwing a recursion error.
    expect(res.mission.status).toBe("failed");
    expect(res.failure?.stage).toBe("validation");
    
    // The actual tool was invoked exactly ONCE (because subsequent identical calls are blocked by duplicate guard)
    expect(toolInvocations).toBe(1);

    // The LLM was called exactly 9 times (3 calls per attempt * 3 attempts) and did not spin infinitely.
    expect(worker.calls).toBe(9);
    expect(res.attempts["s1"]).toBe(3);
  });

  it("failed tool receipts persist across supervisor retry attempts to block identical calls", async () => {
    let toolInvocations = 0;
    const searchTool: KernelTool = {
      name: "search_web",
      description: "search the web",
      invoke: async () => {
        toolInvocations += 1;
        throw new Error("transient failure");
      },
    };

    const workers: WorkerSpec[] = [
      { id: "research", description: "web research", prompt: "Prompt", tools: [searchTool] },
    ];

    // Script:
    // Attempt 1: Call search_web. It fails. Then output non-JSON (causing validation retry).
    // Attempt 2 (Retry 1): Call search_web again with the same args. It should be BLOCKED.
    // Finally, output valid JSON so the attempt completes successfully.
    const worker = new ScriptedModel([
      // Attempt 1
      new AIMessage({
        content: "",
        tool_calls: [{ name: "search_web", args: { query: "stable-args" }, id: "c1" }],
      }),
      ai("invalid output"), // causes validation failure
      // Attempt 2 (Supervisor Retry)
      new AIMessage({
        content: "",
        tool_calls: [{ name: "search_web", args: { query: "stable-args" }, id: "c2" }],
      }),
      VALID_OUTPUT, // succeeds here
    ]);

    const kernel = buildKernel({
      plannerModel: new ScriptedModel([ai(planJson(2))]),
      workerModel: worker,
      synthesizerModel: new ScriptedModel([ai("Done.")]),
      workers,
      checkpointer: new MemorySaver(),
    });

    const res = await kernel.invoke(
      {
        turn: { id: "t_retry_persist", chat_id: "1", received_at: new Date().toISOString(), raw_input: "run" },
      },
      { configurable: { thread_id: "thread_retry_persist" } }
    );

    expect(res.mission.status).toBe("done");
    expect(res.attempts["s1"]).toBe(2); // Two attempts total

    // Tool was executed only ONCE (in Attempt 1).
    // In Attempt 2, it was blocked because step_receipts were preserved and alreadyFailedIdentically was triggered!
    expect(toolInvocations).toBe(1);

    // Verify the second attempt was blocked by matching the scratch message content in the call AFTER the block
    const attempt2Msgs = worker.received[3]!.map((m) => String(m.content)).join("\n");
    expect(attempt2Msgs).toContain("already failed in this step — do NOT repeat it");
  });
});
