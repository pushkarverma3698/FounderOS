/**
 * Ironclad E2E "fire drill" — the FULL pipeline, offline at $0:
 * mocked Telegram ctx → runKernelText (real gateway loop: lock, gates,
 * stream, progress placeholder) → REAL StateGraph kernel → scripted models →
 * real tools node (receipts, truncation) → synthesize → reply via ctx.reply.
 *
 * Drills: (1) massive tool payload truncated before the model re-reads it,
 * (2) hallucinated tool call self-corrected without crashing, (3) malformed
 * worker JSON repaired, (4) terminal failure exits cleanly with a formatted
 * diagnostic delivered to Telegram.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import { MemorySaver } from "@langchain/langgraph";
import { AIMessage, isToolMessage, type BaseMessage } from "@langchain/core/messages";

vi.mock("../../../src/gateway/kernel-boot.js", () => ({
  getKernel: vi.fn(async () => currentKernel),
}));
vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: vi.fn(async () => null),
  resolveInterrupt: vi.fn(async () => ({})),
  getTodayCostUsd: vi.fn(async () => 0),
  logLlmCost: vi.fn(async () => ({})),
  insertScheduledTask: vi.fn(async () => ({ id: "task-1" })),
  writeTaskOutcome: vi.fn(async () => ({})),
}));
vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: vi.fn(async () => null),
  formatHaltNotice: vi.fn(() => "halted"),
}));

import {
  buildKernel,
  digestToolResult,
  receiptsBlock,
  KERNEL_SCHEMA_VERSION,
  TOOL_OUTPUT_MAX_CHARS,
  TOOL_OUTPUT_TRUNCATED_MARKER,
  type CompiledKernel,
  type KernelBindableModel,
  type KernelTool,
  type WorkerSpec,
} from "../../../src/kernel/index.js";
import { runKernelText, threadIdFor } from "../../../src/gateway/kernel-run.js";

let currentKernel: CompiledKernel;

// ── Scripted model (same fetch-free boundary as kernel-e2e) ──────────────────

class ScriptedModel implements KernelBindableModel {
  calls = 0;
  received: BaseMessage[][] = [];
  constructor(private script: Array<AIMessage | ((msgs: BaseMessage[]) => AIMessage)>, private loop = false) {}
  bindTools(): ScriptedModel {
    return this;
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.received.push(messages);
    const idx = this.loop ? this.calls % this.script.length : this.calls;
    this.calls += 1;
    const entry = this.script[idx];
    if (!entry) throw new Error(`ScriptedModel exhausted after ${this.calls - 1} calls`);
    return typeof entry === "function" ? entry(messages) : entry;
  }
}

const ai = (content: string) => new AIMessage(content);
const aiTool = (name: string, args: Record<string, unknown>, id = "c1") =>
  new AIMessage({ content: "", tool_calls: [{ name, args, id, type: "tool_call" }] });

const planJson = (steps: unknown[]) =>
  JSON.stringify({ type: "plan", plan: { schema_version: KERNEL_SCHEMA_VERSION, goal: "fire drill", steps } });

const researchStep = (over: Record<string, unknown> = {}) => ({
  step_id: "s1",
  worker: "research",
  objective: "Scrape competitor pricing and summarize the findings",
  inputs: {},
  expected: { kind: "data", schema_ref: "research.findings" },
  constraints: { max_tool_calls: 3, hitl_required: false },
  ...over,
});

function kernelWith(planner: ScriptedModel, worker: ScriptedModel, synth: ScriptedModel, tools: KernelTool[]) {
  const workers: WorkerSpec[] = [
    { id: "research", description: "web research", prompt: "You are the research worker.", tools },
  ];
  return buildKernel({
    plannerModel: planner,
    workerModel: worker,
    synthesizerModel: synth,
    workers,
    checkpointer: new MemorySaver(),
  });
}

function makeCtx(chatId: number) {
  const replies: string[] = [];
  const ctx = {
    chat: { id: chatId },
    reply: vi.fn(async (text: string) => {
      replies.push(text);
      return { message_id: replies.length };
    }),
    api: {
      editMessageText: vi.fn(async () => true),
      deleteMessage: vi.fn(async () => true),
    },
  } as unknown as Context;
  return { ctx, replies };
}

// ── Drills ────────────────────────────────────────────────────────────────────

describe("Ironclad fire drill (Telegram gateway → real kernel graph)", () => {
  it("truncates a massive tool payload before the model re-reads it — receipts keep the FULL digest", async () => {
    const hugePayload = `{"pricing_rows":[${'"row",'.repeat(60_000)}"final-row"]}`;
    expect(hugePayload.length).toBeGreaterThan(200_000);

    const scraper: KernelTool = {
      name: "scrape_site",
      description: "scrape a website",
      invoke: async () => hugePayload,
    };
    const planner = new ScriptedModel([ai(planJson([researchStep()]))]);
    const worker = new ScriptedModel([
      aiTool("scrape_site", { url: "https://competitor.example" }),
      ai(JSON.stringify({ summary: "Competitor charges $99/mo", sources: [] })),
    ]);
    const synth = new ScriptedModel([ai("Competitor pricing: $99/mo.")]);
    currentKernel = kernelWith(planner, worker, synth, [scraper]);

    const { ctx, replies } = makeCtx(101);
    await runKernelText(ctx, "Scrape competitor pricing and summarize it");

    // The worker's SECOND turn re-read the tool result — it must be clamped.
    const secondTurn = worker.received[1]!;
    const toolMsg = secondTurn.find((m) => isToolMessage(m))!;
    const seen = String(toolMsg.content);
    expect(seen.length).toBeLessThan(TOOL_OUTPUT_MAX_CHARS + 400);
    expect(seen).toContain(TOOL_OUTPUT_TRUNCATED_MARKER);

    // Ground truth unchanged: the INTERNAL receipts carry the FULL-payload digest,
    // even though the founder's reply never shows a digest or a tool name.
    const finalReply = replies.at(-1)!;
    expect(finalReply).toContain("Competitor pricing: $99/mo.");
    expect(finalReply).toContain("completed and verified");
    expect(finalReply).not.toContain("scrape_site");
    expect(finalReply).not.toContain(digestToolResult(hugePayload).slice(0, 8));

    const state = await currentKernel.getState({ configurable: { thread_id: threadIdFor(101) } });
    expect(receiptsBlock(state.values.results)).toContain(digestToolResult(hugePayload).slice(0, 8));
  });

  it("recovers from a HALLUCINATED tool call — rejected in-band, model self-corrects, turn completes", async () => {
    const real: KernelTool = {
      name: "search_web",
      description: "search the web",
      invoke: async () => JSON.stringify({ success: true, data: "3 competitors found" }),
    };
    const planner = new ScriptedModel([ai(planJson([researchStep()]))]);
    const worker = new ScriptedModel([
      aiTool("make_coffee", { size: "large" }), // does not exist
      (msgs) => {
        // The graph must have told the model, in-band, that the tool is unknown.
        const lastTool = [...msgs].reverse().find((m) => isToolMessage(m))!;
        expect(String(lastTool.content)).toContain('Unknown tool "make_coffee"');
        return aiTool("search_web", { q: "competitors" }, "c2");
      },
      ai(JSON.stringify({ summary: "Found 3 competitors", sources: [] })),
    ]);
    const synth = new ScriptedModel([ai("There are 3 competitors.")]);
    currentKernel = kernelWith(planner, worker, synth, [real]);

    const { ctx, replies } = makeCtx(102);
    await runKernelText(ctx, "Research our competitors");

    const finalReply = replies.at(-1)!;
    expect(finalReply).toContain("There are 3 competitors.");
    expect(finalReply).toContain("1 action completed and verified");

    // Only the REAL tool earned a receipt — asserted on the internal record,
    // which is where tool identity lives now.
    const state = await currentKernel.getState({ configurable: { thread_id: threadIdFor(102) } });
    const internal = receiptsBlock(state.values.results);
    expect(internal).toContain("search_web");
    expect(internal).not.toContain("make_coffee");
  });

  it("repairs MALFORMED worker JSON (trailing comma) instead of dropping the task", async () => {
    const planner = new ScriptedModel([ai(planJson([researchStep()]))]);
    // Broken JSON a weak/local model would emit — jsonrepair must salvage it.
    const worker = new ScriptedModel([
      ai('{"summary": "Turicks has 3 direct competitors", "sources": [],}'),
    ]);
    const synth = new ScriptedModel([ai("Turicks has 3 direct competitors.")]);
    currentKernel = kernelWith(planner, worker, synth, []);

    const { ctx, replies } = makeCtx(103);
    await runKernelText(ctx, "How many competitors do we have?");

    expect(replies.at(-1)).toContain("Turicks has 3 direct competitors.");
  });

  it("TOTAL FAILURE exits the loop after max retries and delivers a formatted diagnostic to Telegram", async () => {
    const dying: KernelTool = {
      name: "post_update",
      description: "post an update",
      invoke: async () => {
        throw new Error("upstream API permanently broken");
      },
    };
    const planner = new ScriptedModel([
      ai(planJson([researchStep({
        objective: "Post the pricing update to the site",
        expected: { kind: "action_receipt", schema_ref: "action.summary" },
      })])),
    ]);
    // Pathological model: claims success forever with no successful receipt.
    const worker = new ScriptedModel(
      [aiTool("post_update", { body: "update" }), ai(JSON.stringify({ summary: "posted!" }))],
      true,
    );
    const synth = new ScriptedModel([]);
    currentKernel = kernelWith(planner, worker, synth, [dying]);

    const { ctx, replies } = makeCtx(104);
    await runKernelText(ctx, "Post the pricing update");

    const finalReply = replies.at(-1)!;
    // Clean exit with the typed diagnostic: stage + component + what is preserved.
    expect(finalReply).toContain("Task stopped");
    expect(finalReply).toContain("validation failure");
    expect(finalReply).toContain("completed steps are preserved");
    // The synthesizer never ran — no reply was fabricated from a failed mission.
    expect(synth.calls).toBe(0);
  });

  it("the progress placeholder is sent while working and deleted when the turn ends", async () => {
    const planner = new ScriptedModel([ai(JSON.stringify({ type: "reply", text: "Hi — all good." }))]);
    currentKernel = kernelWith(planner, new ScriptedModel([]), new ScriptedModel([]), []);

    const { ctx, replies } = makeCtx(105);
    await runKernelText(ctx, "hello");

    expect(replies[0]).toContain("Working on it");
    expect(replies.at(-1)).toContain("Hi — all good.");
    expect((ctx as unknown as { api: { deleteMessage: ReturnType<typeof vi.fn> } }).api.deleteMessage).toHaveBeenCalled();
  });
});
